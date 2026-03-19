// ──────────────────────────────────────────────────────────────
// Provider — thin orchestration layer
// ──────────────────────────────────────────────────────────────
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

import type { ModelItem, ApiMode } from "./types";
import { Config, parseModelId } from "./config";
import { ApiKeyManager } from "./services/apiKeyManager";
import { executeWithRetry } from "./services/retryService";
import { interceptSystemPrompt } from "./prompt/interceptor";

// Adapters
import { BaseAdapter } from "./adapters/base";
import { OpenAIAdapter } from "./adapters/openai";
import { OpenAIResponsesAdapter } from "./adapters/openaiResponses";
import { AnthropicAdapter } from "./adapters/anthropic";
import { GeminiAdapter } from "./adapters/gemini";
import { OllamaAdapter } from "./adapters/ollama";

const DEFAULT_CONTEXT_LENGTH = 128000;
const DEFAULT_MAX_TOKENS = 4096;
const EXTENSION_LABEL = "OmniChat";

// ── Stateful marker for Responses API ──
const STATEFUL_MARKER_MIME = "application/vnd.omnichat.stateful-marker";

/**
 * Omni Chat Provider — universal language model provider for VS Code.
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

	// ── Model listing ──

	async provideLanguageModelChatInformation(
		_options: { silent: boolean },
		_token: CancellationToken
	): Promise<LanguageModelChatInformation[]> {
		const models = Config.getModels();

		if (!models.length) {
			return [];
		}

		return models
			.filter((m) => !m.id.startsWith("__provider__"))
			.map((m) => {
				const contextLen = m.context_length ?? DEFAULT_CONTEXT_LENGTH;
				const maxOutput = this.getMaxOutputTokens(m) ?? DEFAULT_MAX_TOKENS;
				const maxInput = Math.max(1, contextLen - maxOutput);
				const modelId = m.configId ? `${m.id}::${m.configId}` : m.id;
				const modelName = m.displayName || modelId;
				const detail = m.owned_by ? `${m.owned_by} (${EXTENSION_LABEL})` : EXTENSION_LABEL;

				return {
					id: modelId,
					name: modelName,
					detail,
					tooltip: detail,
					family: m.family ?? EXTENSION_LABEL,
					version: "1.0.0",
					maxInputTokens: maxInput,
					maxOutputTokens: maxOutput,
					capabilities: {
						toolCalling: true,
						imageInput: m.vision ?? false,
					},
				} satisfies LanguageModelChatInformation;
			});
	}

	// ── Token counting ──

	async provideTokenCount(
		_model: LanguageModelChatInformation,
		text: string | LanguageModelChatRequestMessage,
		_token: CancellationToken
	): Promise<number> {
		// Simple estimation — can be enhanced with actual tokenizer later
		if (typeof text === "string") {
			return Math.ceil(text.length / 4);
		}
		let total = 4; // base per message
		for (const part of text.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				total += Math.ceil(part.value.length / 4);
			}
		}
		return total;
	}

	// ── Chat response ──

	async provideLanguageModelChatResponse(
		model: LanguageModelChatInformation,
		messages: readonly LanguageModelChatRequestMessage[],
		options: ProvideLanguageModelChatResponseOptions,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<void> {
		const safeProgress: Progress<LanguageModelResponsePart2> = {
			report: (part) => {
				try { progress.report(part); } catch (e) {
					console.error("[OmniChat] Progress.report failed", e);
				}
			},
		};

		try {
			// 1. Find model config
			const parsedId = parseModelId(model.id);
			const um = this.findModelConfig(parsedId);

			// 2. Apply delay
			await this.applyDelay(um);

			// 3. Get API key
			const useGenericKey = !um?.baseUrl;
			const apiKey = await this._keyManager.ensureKey(um?.owned_by, useGenericKey);
			if (!apiKey) {
				throw new Error("API key not found");
			}

			// 4. Resolve base URL
			const baseUrl = um?.baseUrl || Config.getBaseUrl();
			if (!baseUrl?.startsWith("http")) {
				throw new Error("Invalid base URL");
			}

			// 5. Select adapter
			const apiMode: ApiMode = um?.apiMode ?? "openai";
			const adapter = this.createAdapter(apiMode);

			// 6. Convert messages with system prompt interception
			const interceptedMessages = interceptSystemPrompt(
				messages,
				Config.getSystemPromptMode(),
				Config.getSystemPromptContent()
			);

			const modelConfig = {
				includeReasoningInRequest: um?.include_reasoning_in_request ?? false,
			};
			const convertedMessages = adapter.convertMessages(interceptedMessages, modelConfig);

			// 7. Build request
			const request = adapter.buildRequest(
				um ?? { id: parsedId.baseId, owned_by: "" },
				baseUrl,
				apiKey,
				convertedMessages,
				options
			);

			// 8. Send with retry
			const retryConfig = Config.getRetryConfig();
			const response = await executeWithRetry(async () => {
				const res = await fetch(request.url, {
					method: "POST",
					headers: request.headers,
					body: JSON.stringify(request.body),
				});
				if (!res.ok) {
					const errorText = await res.text();
					throw new Error(
						`API error: [${res.status}] ${res.statusText}${errorText ? `\n${errorText}` : ""}\nURL: ${request.url}`
					);
				}
				return res;
			}, retryConfig);

			if (!response.body) {
				throw new Error("No response body");
			}

			// 9. Process stream
			const result = await adapter.processStream(response.body, safeProgress, token);

			// 10. Stateful marker (Responses API)
			if (result.responseId) {
				safeProgress.report(createStatefulMarkerPart(parsedId.baseId, result.responseId));
			}

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

	// ── Private helpers ──

	private findModelConfig(parsedId: { baseId: string; configId?: string }): ModelItem | undefined {
		const models = Config.getModels();

		// Exact match (id + configId)
		let found = models.find((m) =>
			m.id === parsedId.baseId &&
			((parsedId.configId && m.configId === parsedId.configId) ||
				(!parsedId.configId && !m.configId))
		);

		// Fallback: any model with same base ID
		if (!found) {
			found = models.find((m) => m.id === parsedId.baseId);
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
		// Each API has its own native parameter name
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

// ── Stateful marker helpers ──

function createStatefulMarkerPart(modelId: string, marker: string): vscode.LanguageModelDataPart {
	const payload = `${modelId}\\${marker}`;
	const bytes = new TextEncoder().encode(payload);
	return new vscode.LanguageModelDataPart(bytes, STATEFUL_MARKER_MIME);
}
