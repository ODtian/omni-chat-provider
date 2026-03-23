// ──────────────────────────────────────────────────────────────
// Gemini native API adapter
// ──────────────────────────────────────────────────────────────
import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart2,
	LanguageModelToolCallPart,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type { GeminiModelItem, ModelItem } from "../types";
import { BaseAdapter, type ConvertedMessages, type PreparedRequest, type StreamResult } from "./base";
import {
	normalizeChatMessage,
	tryParseJSON,
} from "../utils/helpers";
import { convertToolsToGemini } from "../utils/toolConverter";

const GEMINI_SIGNATURE_MARKER_TYPE = "gemini_thought_signature";

type GeminiEndpointAction = "streamGenerateContent" | "countTokens";

function normalizeGeminiModelId(modelId: string): string {
	return modelId.replace(/^models\//i, "").trim();
}

export function buildGeminiApiUrl(
	baseUrl: string,
	modelId: string,
	action: GeminiEndpointAction
): string {
	const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
	const normalizedModelId = normalizeGeminiModelId(modelId);
	const suffix = action === "streamGenerateContent" ? "?alt=sse" : "";

	if (/\/v1beta\/models$/i.test(normalizedBaseUrl)) {
		return `${normalizedBaseUrl}/${normalizedModelId}:${action}${suffix}`;
	}

	if (/\/v1beta$/i.test(normalizedBaseUrl)) {
		return `${normalizedBaseUrl}/models/${normalizedModelId}:${action}${suffix}`;
	}

	return `${normalizedBaseUrl}/v1beta/models/${normalizedModelId}:${action}${suffix}`;
}

interface GeminiPart {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	functionCall?: {
		id?: string;
		name: string;
		args?: Record<string, unknown>;
	};
	functionResponse?: {
		id?: string;
		name: string;
		response: Record<string, unknown>;
	};
}

interface GeminiContent {
	role: "user" | "model";
	parts: GeminiPart[];
}

export class GeminiAdapter extends BaseAdapter {
	private _directToolCallSequence = 0;

	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): ConvertedMessages<GeminiContent> {
		const systemParts: string[] = [];
		const contents: GeminiContent[] = [];
		const toolCallNames = new Map<string, string>();

		for (const m of messages) {
			const normalized = normalizeChatMessage(m, {
				includeReasoningInRequest: modelConfig.includeReasoningInRequest,
			});
			const role = normalized.role;
			const parts: GeminiPart[] = [];
			let lastAttachablePart: GeminiPart | undefined;

			for (const textPart of normalized.textParts) {
				if (!textPart) {
					continue;
				}

				const geminiPart: GeminiPart = { text: textPart };
				parts.push(geminiPart);
				lastAttachablePart = geminiPart;
			}

			for (const toolCall of normalized.toolCalls) {
				toolCallNames.set(toolCall.id, toolCall.name);
				const parsedArgs = tryParseJSON(toolCall.arguments);
				const geminiPart: GeminiPart = {
					functionCall: {
						id: toolCall.id,
						name: toolCall.name,
						args: parsedArgs.ok
							? parsedArgs.value
							: {},
					},
				};
				parts.push(geminiPart);
				lastAttachablePart = geminiPart;
			}

			for (const toolResult of normalized.toolResults) {
				const parsed = tryParseJSON(toolResult.content);
				const functionName = toolCallNames.get(toolResult.callId) ?? toolResult.callId;
				const geminiPart: GeminiPart = {
					functionResponse: {
						id: toolResult.callId,
						name: functionName,
						response: parsed.ok ? parsed.value : { result: toolResult.content || "" },
					},
				};
				parts.push(geminiPart);
				lastAttachablePart = geminiPart;
			}

			for (const thinkingPart of normalized.thinkingParts) {
				const metadata = thinkingPart.metadata;
				if (metadata?.type === "retry_notice") {
					continue;
				}

				if (metadata?.type === GEMINI_SIGNATURE_MARKER_TYPE) {
					if (lastAttachablePart && typeof metadata.thoughtSignature === "string") {
						lastAttachablePart.thoughtSignature = metadata.thoughtSignature;
					}
					continue;
				}

				const thinkingText = thinkingPart.text;
				if (!thinkingText) {
					continue;
				}

				const geminiPart: GeminiPart = {
					text: thinkingText,
					thought: true,
				};
				if (typeof metadata?.thoughtSignature === "string") {
					geminiPart.thoughtSignature = metadata.thoughtSignature;
				}
				parts.push(geminiPart);
				lastAttachablePart = geminiPart;
			}

			const joinedText = parts
				.map((part) => part.text ?? "")
				.join("")
				.trim();

			if (role === "system" && joinedText) {
				systemParts.push(joinedText);
				continue;
			}

			if (parts.length > 0) {
				const geminiRole = role === "assistant" ? "model" : "user";
				contents.push({ role: geminiRole, parts });
			}
		}

		return {
			messages: contents,
			systemContent: systemParts.length > 0 ? systemParts.join("\n") : undefined,
		};
	}

	buildRequest(
		model: ModelItem,
		baseUrl: string,
		apiKey: string,
		converted: ConvertedMessages<GeminiContent>,
		options?: ProvideLanguageModelChatResponseOptions
	): PreparedRequest {
		const geminiModel = model as GeminiModelItem;
		const { messages, systemContent } = converted;
		const body: Record<string, unknown> = {
			contents: messages,
		};

		if (systemContent) {
			body.systemInstruction = {
				parts: [{ text: systemContent }],
			};
		}

		const genConfig: Record<string, unknown> = {};
		if (model.temperature !== undefined && model.temperature !== null) {
			genConfig.temperature = model.temperature;
		}
		if (model.top_p !== undefined && model.top_p !== null) {
			genConfig.topP = model.top_p;
		}
		const maxOutput = geminiModel.maxOutputTokens;
		if (maxOutput !== undefined) { genConfig.maxOutputTokens = maxOutput; }
		const topK = geminiModel.topK;
		if (topK !== undefined) { genConfig.topK = topK; }
		const topP = geminiModel.topP;
		if (topP !== undefined) { genConfig.topP = topP; }
		const thinkingConfig = geminiModel.thinkingConfig;
		if (thinkingConfig && typeof thinkingConfig === "object") {
			genConfig.thinkingConfig = thinkingConfig;
		}

		if (Object.keys(genConfig).length > 0) {
			body.generationConfig = genConfig;
		}

		const toolConfig = convertToolsToGemini(options);
		if (toolConfig.tools) {
			body.tools = toolConfig.tools;
		}
		if (toolConfig.toolConfig) {
			body.toolConfig = toolConfig.toolConfig;
		}

		if (model.extra) {
			for (const [key, value] of Object.entries(model.extra)) {
				if (value !== undefined) { body[key] = value; }
			}
		}

		const url = buildGeminiApiUrl(baseUrl, model.id, "streamGenerateContent");
		const headers = BaseAdapter.prepareHeaders(apiKey, "gemini", model.headers);

		return { url, headers, body };
	}

	async processStream(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<StreamResult> {
		try {
			await this.processSseStream(responseBody, token, async (data) => {
				try {
					const parsed = JSON.parse(data) as Record<string, unknown>;
					this.processGeminiChunk(parsed, progress);
				} catch {
					// ignore malformed chunk
				}
			});
		} finally {
			this.reportEndThinking(progress);
		}

		return {};
	}

	private processGeminiChunk(
		chunk: Record<string, unknown>,
		progress: Progress<LanguageModelResponsePart2>
	): void {
		const candidates = chunk.candidates as Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(candidates) || candidates.length === 0) { return; }

		const content = candidates[0].content as Record<string, unknown> | undefined;
		if (!content) { return; }

		const parts = content.parts as Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(parts)) { return; }

		for (const part of parts) {
			const text = typeof part.text === "string" ? part.text : "";
			const isThought = part.thought === true;
			const thoughtSignature = typeof part.thoughtSignature === "string"
				? part.thoughtSignature
				: undefined;
			const functionCall = part.functionCall as Record<string, unknown> | undefined;

			if (text) {
				if (isThought) {
					this.bufferThinkingContent(text, progress);
					if (thoughtSignature) {
						this.flushThinkingBuffer(progress);
						this.reportThoughtSignatureMarker(thoughtSignature, progress);
					}
					continue;
				}

				this.reportEndThinking(progress);
				const res = this.processTextContent(text, progress);
				if (res.emittedAny) {
					this.markAssistantTextEmitted();
					if (thoughtSignature) {
						this.reportThoughtSignatureMarker(thoughtSignature, progress);
					}
				}
				continue;
			}

			if (functionCall && typeof functionCall.name === "string") {
				this.reportEndThinking(progress);
				this.emitBeginToolCallsHint(progress);

				const callId = typeof functionCall.id === "string"
					? functionCall.id
					: `call_${Date.now()}_${this._directToolCallSequence}`;
				const args = functionCall.args && typeof functionCall.args === "object"
					? functionCall.args as Record<string, unknown>
					: {};

				progress.report(new LanguageModelToolCallPart(callId, functionCall.name, args));
				this.markToolCallCompleted(this._directToolCallSequence++);
				if (thoughtSignature) {
					this.reportThoughtSignatureMarker(thoughtSignature, progress);
				}
				continue;
			}

			if (thoughtSignature) {
				this.flushThinkingBuffer(progress);
				this.reportThoughtSignatureMarker(thoughtSignature, progress);
			}
		}
	}

	private reportThoughtSignatureMarker(
		thoughtSignature: string,
		progress: Progress<LanguageModelResponsePart2>
	): void {
		progress.report(new vscode.LanguageModelThinkingPart("", undefined, {
			type: GEMINI_SIGNATURE_MARKER_TYPE,
			thoughtSignature,
		}));
	}
}
