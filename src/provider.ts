import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatInformation,
	LanguageModelChatProvider,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart2,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type { ApiMode, ModelItem } from "./types";
import {
	buildScopedModelId,
	Config,
	findConfiguredModelById,
	isInternalProviderModel,
	parseScopedModelId,
} from "./config";
import { ApiKeyManager } from "./services/apiKeyManager";
import {
	EmptyResponseRetryError,
	createNetworkRetryError,
	executeWithRetry,
	RETRY_REASON_LABELS,
	RetryableHttpError,
	shouldRetryRequest,
} from "./services/retryService";
import { interceptSystemPrompt } from "./prompt/interceptor";
import { DEFAULT_MAX_OUTPUT_TOKENS, getModelInputTokenBudget, getModelMaxOutputTokens } from "./modelParams";
import { countTokensForInput } from "./services/tokenCounter";

import { BaseAdapter } from "./adapters/base";
import { OpenAIAdapter } from "./adapters/openai";
import { OpenAIResponsesAdapter } from "./adapters/openaiResponses";
import { AnthropicAdapter } from "./adapters/anthropic";
import { GeminiAdapter } from "./adapters/gemini";
import { OllamaAdapter } from "./adapters/ollama";

const EXTENSION_LABEL = "OmniChat";
const OUTPUT_CHANNEL = vscode.window.createOutputChannel("OmniChat");
const MAX_VISIBLE_ERROR_LENGTH = 220;

type SafeProgressReporter = Progress<LanguageModelResponsePart2>;

interface RetryNoticeState {
	activeId?: string;
}

interface ResolvedRequestContext {
	resolvedModel: ModelItem;
	apiKey: string;
	baseUrl: string;
	apiMode: ApiMode;
	interceptedMessages: readonly LanguageModelChatRequestMessage[];
	modelConfig: { includeReasoningInRequest: boolean };
	retryConfig: ReturnType<typeof Config.getRetryConfig>;
}

interface ProviderChatInformationOptions {
	silent?: boolean;
	configuration?: Record<string, unknown>;
	group?: string;
}

type ProviderGroupConfiguration = {
	providerId?: string;
};

/**
 * Single OmniChat vendor provider.
 *
 * VS Code manages multiple OmniChat groups using the contributed
 * `configuration` schema. Each group selects a single `providerId`.
 */
export class OmniChatProvider implements LanguageModelChatProvider {
	private _lastRequestTime: number | null = null;
	private _requestSequence = 0;
	private readonly _keyManager: ApiKeyManager;

	constructor(secrets: vscode.SecretStorage) {
		this._keyManager = new ApiKeyManager(secrets);
	}

	get keyManager(): ApiKeyManager {
		return this._keyManager;
	}

	async provideLanguageModelChatInformation(
		options: ProviderChatInformationOptions,
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		const groupConfig = this.parseGroupConfiguration(options.configuration);
		const groupName = typeof options.group === "string"
			? options.group
			: undefined;
		if (!groupConfig.providerId) {
			return [];
		}

		const configuredProvider = Config.getProviderById(groupConfig.providerId);
		const providerModels = Config.getModelsForProvider(groupConfig.providerId);
		if (!configuredProvider && providerModels.length === 0) {
			throw new Error(
				`Provider "${groupConfig.providerId}" is not defined in omnichat.providers or omnichat.models.`
			);
		}

		return this.getScopedModels(groupConfig.providerId, groupName);
	}

	private parseGroupConfiguration(configuration?: Record<string, unknown>): ProviderGroupConfiguration {
		const providerId = typeof configuration?.providerId === "string"
			? configuration.providerId.trim()
			: "";

		return {
			providerId: providerId || undefined,
		};
	}

	private getScopedModels(providerId: string, groupLabel?: string): LanguageModelChatInformation[] {
		const models = Config.getModelsForProvider(providerId);
		const detailLabel = groupLabel?.trim() || providerId;

		return models
			.filter((model) => !isInternalProviderModel(model))
			.map((model) => {
				const maxOutput = getModelMaxOutputTokens(model) ?? DEFAULT_MAX_OUTPUT_TOKENS;
				const maxInput = getModelInputTokenBudget(model);
				const modelId = buildScopedModelId(model);
				const fallbackName = model.configId ? `${model.id}::${model.configId}` : model.id;
				const modelName = model.displayName || fallbackName;
				const detail = `${detailLabel} (${EXTENSION_LABEL})`;

				return {
					id: modelId,
					name: modelName,
					detail,
					tooltip: detail,
					family: model.family ?? EXTENSION_LABEL,
					version: "1.0.0",
					maxInputTokens: maxInput,
					maxOutputTokens: maxOutput,
					isUserSelectable: true,
					isDefault: false,
					category: { label: providerId, order: 0 },
					capabilities: {
						toolCalling: true,
						imageInput: model.vision ?? false,
					},
				} satisfies LanguageModelChatInformation;
			});
	}

	async provideTokenCount(
		model: LanguageModelChatInformation,
		text: string | LanguageModelChatRequestMessage,
		token: CancellationToken
	): Promise<number> {
		const resolvedModel = findConfiguredModelById(model.id);
		if (!resolvedModel) {
			return typeof text === "string"
				? Math.ceil(text.length / 4)
				: 4;
		}

		return await countTokensForInput({
			input: text,
			keyManager: this._keyManager,
			model: resolvedModel,
			token,
		});
	}

	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		const safeProgress = this.createSafeProgress(progress);
		const retryNoticeState: RetryNoticeState = {};
		const requestTag = this.createRequestTag(model.id);
		this.logInfo(
			requestTag,
			`Request started. messages=${messages.length}, initiator=${options.requestInitiator ?? "unknown"}`
		);

		try {
			const requestContext = await this.resolveRequestContext(model, messages, requestTag);
			await this.applyDelay(requestContext.resolvedModel, requestTag);
			this._lastRequestTime = Date.now();
			this.logInfo(requestTag, "Dispatching API request.");
			await this.executeChatRequest(
				requestContext,
				options,
				safeProgress,
				token,
				retryNoticeState,
				requestTag
			);
			this.logInfo(requestTag, "Request completed successfully.");
		} catch (err) {
			if (token.isCancellationRequested) {
				this.logWarn(requestTag, "Request ended due to cancellation.");
			}
			throw this.createUserVisibleRequestError(model.id, err, requestTag);
		} finally {
			this.closeRetryNotice(safeProgress, retryNoticeState);
			this.logInfo(requestTag, "Request finished.");
		}
	}

	private createSafeProgress(progress: Progress<LanguageModelResponsePart2>): SafeProgressReporter {
		return {
			report: (part) => {
				try {
					progress.report(part);
				} catch (e) {
					console.error("[OmniChat] Progress.report failed", e);
				}
			},
		};
	}

	private async resolveRequestContext(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		requestTag: string
	): Promise<ResolvedRequestContext> {
		const parsedId = parseScopedModelId(model.id);
		const resolvedModel = this.findModelConfig(parsedId);
		if (!resolvedModel) {
			throw new Error(`Model configuration not found for "${model.id}"`);
		}

		this.logInfo(
			requestTag,
			`Resolved model. provider=${parsedId.providerId || resolvedModel.owned_by}, apiMode=${resolvedModel.apiMode ?? "openai"}`
		);

		const apiKey = await this.resolveApiKey(parsedId.providerId, resolvedModel, requestTag);
		const baseUrl = this.resolveBaseUrl(resolvedModel);
		const apiMode: ApiMode = resolvedModel.apiMode ?? "openai";
		this.logInfo(requestTag, `Using base URL: ${this.sanitizeUrlForLog(baseUrl)}`);

		return {
			resolvedModel,
			apiKey,
			baseUrl,
			apiMode,
			interceptedMessages: interceptSystemPrompt(
				messages,
				Config.getSystemPromptMode(),
				Config.getSystemPromptContent()
			),
			modelConfig: {
				includeReasoningInRequest: resolvedModel.include_reasoning_in_request ?? false,
			},
			retryConfig: Config.getRetryConfig(),
		};
	}

	private async resolveApiKey(providerId: string, resolvedModel: ModelItem, requestTag: string): Promise<string> {
		const useGenericKey = !resolvedModel.baseUrl;
		const keyProvider = providerId || resolvedModel.owned_by;
		const existingKey = await this._keyManager.getKey(keyProvider, useGenericKey);
		if (existingKey) {
			this.logInfo(
				requestTag,
				`API key resolved from secret storage. provider=${keyProvider}, genericFallback=${useGenericKey}`
			);
		} else {
			this.logWarn(
				requestTag,
				`API key missing. Waiting for user input. provider=${keyProvider}, genericFallback=${useGenericKey}`
			);
		}
		const apiKey = await this._keyManager.ensureKey(
			keyProvider,
			useGenericKey
		);
		if (!apiKey) {
			this.logWarn(requestTag, "API key not provided.");
			throw new Error("API key not found");
		}
		if (!existingKey) {
			this.logInfo(requestTag, "API key captured successfully.");
		}
		return apiKey;
	}

	private resolveBaseUrl(resolvedModel: ModelItem): string {
		const baseUrl = resolvedModel.baseUrl || Config.getBaseUrl();
		if (!baseUrl?.startsWith("http")) {
			throw new Error("Invalid base URL");
		}
		return baseUrl;
	}

	private async executeChatRequest(
		context: ResolvedRequestContext,
		options: ProvideLanguageModelChatResponseOptions,
		progress: SafeProgressReporter,
		token: CancellationToken,
		retryNoticeState: RetryNoticeState,
		requestTag: string
	): Promise<void> {
		let activeAdapter: BaseAdapter | undefined;
		this.logInfo(
			requestTag,
			`Retry config enabled=${context.retryConfig.enabled}, maxAttempts=${context.retryConfig.maxAttempts}, intervalMs=${context.retryConfig.intervalMs}, timeoutMs=${context.retryConfig.timeoutMs}`
		);

		await executeWithRetry(async (signal) => {
			await this.executeSingleRequest(context, options, progress, token, signal, (adapter) => {
				activeAdapter = adapter;
			}, requestTag);
		}, context.retryConfig, async (info) => {
			if (token.isCancellationRequested) {
				this.logWarn(requestTag, "Cancellation requested before retry could start.");
				return;
			}
			this.reportRetryNotice(info, progress, retryNoticeState, requestTag);
		}, (error) => {
			const interruptedDuringThinking = activeAdapter?.lastStreamInterruptedDuringThinking ?? false;
			const hasEmittedResponseContent = activeAdapter?.hasEmittedResponseContent ?? false;
			if (interruptedDuringThinking) {
				this.logWarn(
					requestTag,
					`Failure happened during thinking stream. hasEmittedResponseContent=${hasEmittedResponseContent}`
				);
			}
			const retryDecision = shouldRetryRequest({
				error,
				tokenCancelled: token.isCancellationRequested,
				hasEmittedResponseContent,
			});
			if (retryDecision === false) {
				if (token.isCancellationRequested) {
					this.logWarn(requestTag, "Retry skipped because request was cancelled.");
				} else {
					this.logWarn(requestTag, "Retry skipped because partial response content was already emitted.");
				}
			} else if (interruptedDuringThinking) {
				this.logInfo(
					requestTag,
					`Retry remains eligible after thinking interruption. hasEmittedResponseContent=${hasEmittedResponseContent}`
				);
			}
			return retryDecision;
		});
	}

	private async executeSingleRequest(
		context: ResolvedRequestContext,
		options: ProvideLanguageModelChatResponseOptions,
		progress: SafeProgressReporter,
		token: CancellationToken,
		signal: AbortSignal,
		onAdapterCreated: (adapter: BaseAdapter) => void,
		requestTag: string
	): Promise<void> {
		const adapter = this.createAdapter(context.apiMode);
		onAdapterCreated(adapter);
		this.logInfo(requestTag, `Adapter created: ${adapter.constructor.name}`);

		const conversationKey = this.createConversationKey(context.interceptedMessages);
		adapter.prepareRequestScope({
			requestInitiator: options.requestInitiator,
			modelId: buildScopedModelId(context.resolvedModel),
			conversationKey,
		});

		const convertedMessages = adapter.convertMessages(context.interceptedMessages, context.modelConfig);
		let payload = adapter.buildRequest(
			context.resolvedModel,
			context.baseUrl,
			context.apiKey,
			convertedMessages,
			options
		);
		this.logInfo(
			requestTag,
			`Prepared request payload. url=${this.sanitizeUrlForLog(payload.url)}, messageCount=${convertedMessages.messages.length}`
		);

		let response: Response;
		try {
			response = await this.fetchChatResponse(payload.url, payload.headers, payload.body, signal, token, requestTag);
		} catch (error) {
			if (!adapter.handleRequestError(error).retryWithFreshRequest) {
				throw error;
			}

			this.logWarn(requestTag, "Adapter request state was rejected. Retrying once with a fresh request payload.");
			console.warn("[OmniChat] Adapter request state rejected, fallback to fresh request.");
			payload = adapter.buildRequest(
				context.resolvedModel,
				context.baseUrl,
				context.apiKey,
				convertedMessages,
				options
			);
			response = await this.fetchChatResponse(payload.url, payload.headers, payload.body, signal, token, requestTag);
		}

		if (!response.body) {
			this.logWarn(requestTag, "Response received without body.");
			throw new EmptyResponseRetryError("No response body");
		}

		const result = await this.processAdapterStream(adapter, response.body, progress, token, requestTag);
		adapter.commitStreamResult(result);
		if (result.responseId) {
			this.logInfo(requestTag, `Stream completed. responseId=${result.responseId}`);
		} else {
			this.logInfo(requestTag, "Stream completed.");
		}
		if (context.retryConfig.retryEmptyResponse && !adapter.hasEmittedResponseContent) {
			if (adapter.lastStreamInterruptedDuringThinking) {
				this.logWarn(
					requestTag,
					"Thinking stream was interrupted before any response content was emitted. Empty-response retry path will be used."
				);
			}
			this.logWarn(requestTag, "Response stream finished without emitting response content. Will be treated as empty response.");
			throw new EmptyResponseRetryError();
		}
	}

	private async fetchChatResponse(
		url: string,
		headers: Record<string, string>,
		body: unknown,
		signal: AbortSignal,
		token: CancellationToken,
		requestTag: string
	): Promise<Response> {
		const controller = new AbortController();
		const onAbort = () => {
			this.logWarn(requestTag, "Abort signal received while waiting for HTTP response.");
			controller.abort();
		};
		signal.addEventListener("abort", onAbort);
		const tokenDisp = token.onCancellationRequested(onAbort);

		let response: Response;
		try {
			this.logInfo(requestTag, `Sending HTTP POST to ${this.sanitizeUrlForLog(url)}`);
			response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			throw createNetworkRetryError(`Request failed before response was received: ${cause.message}`, cause);
		} finally {
			signal.removeEventListener("abort", onAbort);
			tokenDisp.dispose();
		}

		if (!response.ok) {
			const errorText = await response.text();
			this.logWarn(requestTag, `HTTP response not OK. status=${response.status} ${response.statusText}`);
			throw new RetryableHttpError(response.status, response.statusText, errorText || undefined, url);
		}

		this.logInfo(requestTag, `HTTP response received. status=${response.status} ${response.statusText}`);

		return response;
	}

	private async processAdapterStream(
		adapter: BaseAdapter,
		body: ReadableStream<Uint8Array>,
		progress: SafeProgressReporter,
		token: CancellationToken,
		requestTag: string
	): Promise<{ responseId?: string }> {
		try {
			this.logInfo(requestTag, "Beginning response stream processing.");
			return await adapter.processStream(body, progress, token);
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			if (adapter.lastStreamInterruptedDuringThinking) {
				this.logWarn(
					requestTag,
					"Response stream failed while a thinking section was active."
				);
			}
			this.logWarn(requestTag, `Response stream failed: ${cause.message}`);
			throw createNetworkRetryError(`Response stream failed: ${cause.message}`, cause);
		}
	}

	private createUserVisibleRequestError(modelId: string, error: unknown, requestTag?: string): Error {
		const message = error instanceof Error ? error.message : String(error);
		OUTPUT_CHANNEL.appendLine(`[${new Date().toISOString()}] Request failed for ${modelId}`);
		OUTPUT_CHANNEL.appendLine(message);
		if (error instanceof Error && error.stack) {
			OUTPUT_CHANNEL.appendLine(error.stack);
		}
		OUTPUT_CHANNEL.appendLine("");
		console.error("[OmniChat] Request failed", {
			modelId,
			error: message,
		});
		if (requestTag) {
			this.logError(requestTag, `Request failed: ${message}`);
		}
		
		const displayType = "OmniChat API Request Error";
		// To prevent VS Code from displaying giant raw HTML stack traces in chat responses,
		// we strip out the original stack.
		const err = new Error(truncateErrorForUser(message));
		err.name = displayType;
		err.stack = `${displayType}: ${err.message}`;
		return err;
	}

	private reportRetryNotice(
		info: Parameters<NonNullable<Parameters<typeof executeWithRetry>[2]>>[0],
		progress: SafeProgressReporter,
		state: RetryNoticeState,
		requestTag: string
	): void {
		const nextTimeText = info.nextRetryAt.toLocaleTimeString("zh-CN", {
			hour12: false,
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		const reasonLabel = RETRY_REASON_LABELS[info.reason];
		const body = `${reasonLabel}. Retrying ${info.attemptNumber}/${info.maxAttempts} at ${nextTimeText}.`;
		this.logWarn(
			requestTag,
			`${reasonLabel}. Retry ${info.attemptNumber}/${info.maxAttempts} scheduled at ${info.nextRetryAt.toISOString()}. error=${info.error.message}`
		);

		if (state.activeId) {
			progress.report(new vscode.LanguageModelThinkingPart("", state.activeId));
		}

		state.activeId = `retry_notice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
		progress.report(new vscode.LanguageModelThinkingPart(body, state.activeId, {
			type: "retry_notice",
			attemptNumber: info.attemptNumber,
			reason: info.reason,
			nextRetryAt: info.nextRetryAt.toISOString(),
		}));
	}

	private closeRetryNotice(progress: SafeProgressReporter, state: RetryNoticeState): void {
		if (!state.activeId) {
			return;
		}

		progress.report(new vscode.LanguageModelThinkingPart("", state.activeId));
		state.activeId = undefined;
	}

	private findModelConfig(parsedId: { providerId: string; baseId: string; configId?: string }): ModelItem | undefined {
		const scopedId = parsedId.providerId
			? `${parsedId.providerId}/${parsedId.baseId}${parsedId.configId ? `::${parsedId.configId}` : ""}`
			: parsedId.baseId;
		return findConfiguredModelById(scopedId);
	}

	private async applyDelay(model?: ModelItem, requestTag?: string): Promise<void> {
		const delayMs = Config.getDelay(model);
		if (delayMs <= 0 || this._lastRequestTime === null) {
			return;
		}

		const elapsed = Date.now() - this._lastRequestTime;
		if (elapsed >= delayMs) {
			return;
		}

		const waitMs = delayMs - elapsed;
		if (requestTag) {
			this.logInfo(requestTag, `Applying configured delay. waitMs=${waitMs}, configuredDelayMs=${delayMs}, elapsedSinceLastStartMs=${elapsed}`);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
		if (requestTag) {
			this.logInfo(requestTag, `Delay finished after ${waitMs}ms.`);
		}
	}

	private createRequestTag(modelId: string): string {
		this._requestSequence += 1;
		return `req-${this._requestSequence}:${modelId}`;
	}

	private sanitizeUrlForLog(url: string): string {
		return url.replace(/[?&]([^=]*key|token|secret|password)=([^&]+)/gi, (_m, key) => `?${key}=***`);
	}

	private logInfo(requestTag: string, message: string): void {
		this.appendOutput("INFO", requestTag, message);
	}

	private logWarn(requestTag: string, message: string): void {
		this.appendOutput("WARN", requestTag, message);
	}

	private logError(requestTag: string, message: string): void {
		this.appendOutput("ERROR", requestTag, message);
	}

	private appendOutput(level: "INFO" | "WARN" | "ERROR", requestTag: string, message: string): void {
		OUTPUT_CHANNEL.appendLine(`[${new Date().toISOString()}] [${level}] [${requestTag}] ${message}`);
	}

	private createAdapter(apiMode: ApiMode): BaseAdapter {
		switch (apiMode) {
			case "openai":
				return new OpenAIAdapter();
			case "openai-responses":
				return new OpenAIResponsesAdapter();
			case "anthropic":
				return new AnthropicAdapter();
			case "gemini":
				return new GeminiAdapter();
			case "ollama":
				return new OllamaAdapter();
			default:
				console.warn(`[OmniChat] Unknown apiMode "${apiMode}", falling back to OpenAI`);
				return new OpenAIAdapter();
		}
	}

	private createConversationKey(messages: readonly LanguageModelChatRequestMessage[]): string {
		const pieces: string[] = [];

		for (const message of messages) {
			const role = String(message.role);
			let textPreview = "";
			let textLength = 0;
			let imageCount = 0;
			let toolCallCount = 0;
			let toolResultCount = 0;

			for (const part of message.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textLength += part.value.length;
					if (textPreview.length < 120) {
						textPreview += part.value.slice(0, 120 - textPreview.length);
					}
					continue;
				}

				if (part instanceof vscode.LanguageModelDataPart) {
					imageCount += 1;
					continue;
				}

				if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCallCount += 1;
					continue;
				}

				if (part && typeof part === "object" && "callId" in (part as Record<string, unknown>)) {
					toolResultCount += 1;
				}
			}

			pieces.push(
				`${role}|t:${textLength}|p:${textPreview}|i:${imageCount}|tc:${toolCallCount}|tr:${toolResultCount}`
			);
		}

		const source = pieces.join("||") || "empty";
		let hash = 2166136261;
		for (let i = 0; i < source.length; i++) {
			hash ^= source.charCodeAt(i);
			hash = Math.imul(hash, 16777619);
		}

		return `conv_${(hash >>> 0).toString(36)}`;
	}

}

function truncateErrorForUser(message: string): string {
	const singleLine = message.replace(/\s+/g, " ").trim();
	if (singleLine.length <= MAX_VISIBLE_ERROR_LENGTH) {
		return singleLine;
	}
	return `${singleLine.slice(0, MAX_VISIBLE_ERROR_LENGTH)}… See OmniChat output for details.`;
}
