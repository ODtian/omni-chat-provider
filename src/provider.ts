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
import { buildScopedModelId, Config, parseScopedModelId } from "./config";
import { ApiKeyManager } from "./services/apiKeyManager";
import { executeWithRetry } from "./services/retryService";
import { interceptSystemPrompt } from "./prompt/interceptor";

import { BaseAdapter } from "./adapters/base";
import { OpenAIAdapter } from "./adapters/openai";
import { OpenAIResponsesAdapter } from "./adapters/openaiResponses";
import { AnthropicAdapter } from "./adapters/anthropic";
import { GeminiAdapter } from "./adapters/gemini";
import { OllamaAdapter } from "./adapters/ollama";

const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const EXTENSION_LABEL = "OmniChat";
const STATEFUL_MARKER_MIME = "application/vnd.omnichat.stateful-marker";

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
		_model: LanguageModelChatInformation,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		if (typeof text === "string") {
			return Math.ceil(text.length / 4);
		}
		let total = 4;
		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += Math.ceil(part.value.length / 4);
			}
		}
		return total;
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

			await executeWithRetry(async () => {
				const adapter = this.createAdapter(apiMode);
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

				if (result.responseId) {
					safeProgress.report(createStatefulMarkerPart(model.id, result.responseId));
				}
			}, retryConfig);
		} catch (err) {
			console.error("[OmniChat] Request failed", {
				modelId: model.id,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		} finally {
			this._lastRequestTime = Date.now();
		}
	}

	private findModelConfig(parsedId: { providerId: string; baseId: string; configId?: string }): ModelItem | undefined {
		const models = parsedId.providerId
			? Config.getModelsForProvider(parsedId.providerId)
			: Config.getModels();

		let found = models.find((model) =>
			model.id === parsedId.baseId &&
			((parsedId.configId && model.configId === parsedId.configId) ||
				(!parsedId.configId && !model.configId))
		);

		if (!found) {
			found = models.find((model) => model.id === parsedId.baseId);
		}

		return found;
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

function createStatefulMarkerPart(modelId: string, marker: string): vscode.LanguageModelDataPart {
	const payload = `${modelId}\\${marker}`;
	const bytes = new TextEncoder().encode(payload);
	return new vscode.LanguageModelDataPart(bytes, STATEFUL_MARKER_MIME);
}
