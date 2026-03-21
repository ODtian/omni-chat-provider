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
import { buildScopedModelId, Config, findConfiguredModelById, parseScopedModelId } from "./config";
import { ApiKeyManager } from "./services/apiKeyManager";
import { executeWithRetry } from "./services/retryService";
import { interceptSystemPrompt } from "./prompt/interceptor";
import { countTokensForInput } from "./services/tokenCounter";

import { BaseAdapter } from "./adapters/base";
import { OpenAIAdapter } from "./adapters/openai";
import { OpenAIResponsesAdapter } from "./adapters/openaiResponses";
import { AnthropicAdapter } from "./adapters/anthropic";
import { GeminiAdapter } from "./adapters/gemini";
import { OllamaAdapter } from "./adapters/ollama";

const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const EXTENSION_LABEL = "OmniChat";
const OUTPUT_CHANNEL = vscode.window.createOutputChannel("OmniChat");
const MAX_VISIBLE_ERROR_LENGTH = 220;

interface ProviderGroupConfiguration {
	providerId?: string;
}

/**
 * Single OmniChat vendor provider.
 *
 * VS Code manages multiple OmniChat groups using the contributed
 * `configuration` schema. Each group selects a single `providerId`.
 */
export class OmniChatProvider implements LanguageModelChatProvider {
	private _lastRequestTime: number | null = null;
	private readonly _keyManager: ApiKeyManager;

	constructor(secrets: vscode.SecretStorage) {
		this._keyManager = new ApiKeyManager(secrets);
	}

	get keyManager(): ApiKeyManager {
		return this._keyManager;
	}

	async provideLanguageModelChatInformation(
		options: { silent?: boolean; configuration?: Record<string, any> },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		const groupConfig = this.parseGroupConfiguration(options.configuration);
		const groupName = typeof (options as any).group === "string"
			? (options as any).group
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

	private parseGroupConfiguration(configuration?: Record<string, any>): ProviderGroupConfiguration {
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
			.filter((model) => !model.id.startsWith("__provider__"))
			.map((model) => {
				const contextLen = model.context_length ?? DEFAULT_CONTEXT_LENGTH;
				const maxOutput = this.getMaxOutputTokens(model) ?? DEFAULT_MAX_TOKENS;
				const maxInput = Math.max(1, contextLen - maxOutput);
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
		const safeProgress: Progress<LanguageModelResponsePart2> = {
			report: (part) => {
				try {
					progress.report(part);
				} catch (e) {
					console.error("[OmniChat] Progress.report failed", e);
				}
			},
		};
		let activeRetryNoticeId: string | undefined;
		const closeRetryNotice = () => {
			if (!activeRetryNoticeId) {
				return;
			}

			safeProgress.report(new vscode.LanguageModelThinkingPart("", activeRetryNoticeId));
			activeRetryNoticeId = undefined;
		};

		try {
			const parsedId = parseScopedModelId(model.id);
			const resolvedModel = this.findModelConfig(parsedId);
			if (!resolvedModel) {
				throw new Error(`Model configuration not found for "${model.id}"`);
			}

			await this.applyDelay(resolvedModel);

			const useGenericKey = !resolvedModel.baseUrl;
			const apiKey = await this._keyManager.ensureKey(
				parsedId.providerId || resolvedModel.owned_by,
				useGenericKey
			);
			if (!apiKey) {
				throw new Error("API key not found");
			}

			const baseUrl = resolvedModel.baseUrl || Config.getBaseUrl();
			if (!baseUrl?.startsWith("http")) {
				throw new Error("Invalid base URL");
			}

			const apiMode: ApiMode = resolvedModel.apiMode ?? "openai";
			const interceptedMessages = interceptSystemPrompt(
				messages,
				Config.getSystemPromptMode(),
				Config.getSystemPromptContent()
			);
			const modelConfig = {
				includeReasoningInRequest: resolvedModel.include_reasoning_in_request ?? false,
			};
			const retryConfig = Config.getRetryConfig();

			let retryNoticeCount = 0;
			let activeAdapter: BaseAdapter | undefined;
			await executeWithRetry(async () => {
				closeRetryNotice();
				const adapter = this.createAdapter(apiMode);
				activeAdapter = adapter;
				const convertedMessages = adapter.convertMessages(interceptedMessages, modelConfig);

				const payload = adapter.buildRequest(
					resolvedModel,
					baseUrl,
					apiKey,
					convertedMessages,
					options
				);

				const res = await fetch(payload.url, {
					method: "POST",
					headers: payload.headers,
					body: JSON.stringify(payload.body),
				});

				if (!res.ok) {
					const errorText = await res.text();
					throw new Error(
						`API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${payload.url}`
					);
				}

				if (!res.body) {
					throw new Error("No response body [EMPTY_RESPONSE]");
				}

				const result = await adapter.processStream(res.body, safeProgress, token);

				if (retryConfig.retryEmptyResponse && !adapter.hasEmittedAnyContent) {
					throw new Error("API stream ended without yielding any content [EMPTY_RESPONSE]");
				}

				// Responses API exposes a response ID, but our DataPart experiments
				// showed that custom response parts are not fed back into subsequent
				// provider requests by VS Code/Copilot today. Keep the ID available
				// for future stateful implementations instead of emitting marker data.
				void result.responseId;
			}, retryConfig, async (info) => {
				if (token.isCancellationRequested) {
					return;
				}
				retryNoticeCount += 1;
				const nextTimeText = info.nextRetryAt.toLocaleTimeString("zh-CN", {
					hour12: false,
					hour: "2-digit",
					minute: "2-digit",
					second: "2-digit",
				});
				const reasonLabel = info.reason === "empty-response"
					? "Empty response"
					: info.reason === "network"
						? "Network/stream error"
						: info.reason === "http-status"
							? "Retryable request error"
							: info.reason === "timeout"
								? "Request timeout"
								: "Request error";
				const body = `${reasonLabel}. Retrying ${info.attemptNumber}/${info.maxAttempts} at ${nextTimeText}.`;

				closeRetryNotice();
				activeRetryNoticeId = `retry_notice_${Date.now()}_${retryNoticeCount}_${Math.random().toString(36).slice(2, 6)}`;
				safeProgress.report(new vscode.LanguageModelThinkingPart(body, activeRetryNoticeId, {
					type: "retry_notice",
					attemptNumber: info.attemptNumber,
					reason: info.reason,
					nextRetryAt: info.nextRetryAt.toISOString(),
				}));
			}, () => {
				if (token.isCancellationRequested) {
					return false;
				}

				if (activeAdapter?.lastStreamInterruptedDuringThinking) {
					console.warn("[OmniChat] Allow retry because the stream was interrupted during thinking.");
					return true;
				}

				if (activeAdapter?.hasEmittedAnyContent) {
					console.warn("[OmniChat] Skip retry because partial content has already been emitted.");
					return false;
				}

				return undefined;
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			OUTPUT_CHANNEL.appendLine(`[${new Date().toISOString()}] Request failed for ${model.id}`);
			OUTPUT_CHANNEL.appendLine(message);
			OUTPUT_CHANNEL.appendLine("");
			console.error("[OmniChat] Request failed", {
				modelId: model.id,
				error: message,
			});
			throw new Error(truncateErrorForUser(message));
		} finally {
			closeRetryNotice();
			this._lastRequestTime = Date.now();
		}
	}

	private findModelConfig(parsedId: { providerId: string; baseId: string; configId?: string }): ModelItem | undefined {
		const scopedId = parsedId.providerId
			? `${parsedId.providerId}/${parsedId.baseId}${parsedId.configId ? `::${parsedId.configId}` : ""}`
			: parsedId.baseId;
		return findConfiguredModelById(scopedId);
	}

	private async applyDelay(model?: ModelItem): Promise<void> {
		const delayMs = Config.getDelay(model);
		if (delayMs > 0 && this._lastRequestTime !== null) {
			const elapsed = Date.now() - this._lastRequestTime;
			if (elapsed < delayMs) {
				await new Promise<void>((resolve) =>
					setTimeout(resolve, delayMs - elapsed)
				);
			}
		}
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

	private getMaxOutputTokens(model: ModelItem): number | undefined {
		const apiMode = model.apiMode ?? "openai";
		switch (apiMode) {
			case "openai":
				return (model as any).max_completion_tokens ?? (model as any).max_tokens;
			case "openai-responses":
				return (model as any).max_output_tokens;
			case "anthropic":
				return (model as any).max_tokens;
			case "gemini":
				return (model as any).maxOutputTokens;
			case "ollama":
				return (model as any).num_predict;
			default:
				return (model as any).max_tokens;
		}
	}
}

function truncateErrorForUser(message: string): string {
	const singleLine = message.replace(/\s+/g, " ").trim();
	if (singleLine.length <= MAX_VISIBLE_ERROR_LENGTH) {
		return singleLine;
	}
	return `${singleLine.slice(0, MAX_VISIBLE_ERROR_LENGTH)}… See OmniChat output for details.`;
}
