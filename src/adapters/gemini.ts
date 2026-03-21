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

import type { ModelItem } from "../types";
import { BaseAdapter, type PreparedRequest, type StreamResult } from "./base";
import {
	collectToolResultText,
	isToolResultPart,
	mapRole,
	tryParseJSON,
} from "../utils/helpers";
import { convertToolsToGemini } from "../utils/toolConverter";

const GEMINI_SIGNATURE_MARKER_TYPE = "gemini_thought_signature";

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
		_modelConfig: { includeReasoningInRequest: boolean }
	): unknown[] {
		const systemParts: string[] = [];
		const contents: GeminiContent[] = [];
		const toolCallNames = new Map<string, string>();

		for (const m of messages) {
			const role = mapRole(m);
			const parts: GeminiPart[] = [];
			let lastAttachablePart: GeminiPart | undefined;

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					if (!part.value) {
						continue;
					}

					const geminiPart: GeminiPart = { text: part.value };
					parts.push(geminiPart);
					lastAttachablePart = geminiPart;
					continue;
				}

				if (part instanceof vscode.LanguageModelToolCallPart) {
					toolCallNames.set(part.callId, part.name);
					const geminiPart: GeminiPart = {
						functionCall: {
							id: part.callId,
							name: part.name,
							args: part.input as Record<string, unknown>,
						},
					};
					parts.push(geminiPart);
					lastAttachablePart = geminiPart;
					continue;
				}

				if (isToolResultPart(part)) {
					const responseText = collectToolResultText(part);
					const parsed = tryParseJSON(responseText);
					const functionName = toolCallNames.get(part.callId) ?? part.callId;
					const geminiPart: GeminiPart = {
						functionResponse: {
							id: part.callId,
							name: functionName,
							response: parsed.ok ? parsed.value : { result: responseText || "" },
						},
					};
					parts.push(geminiPart);
					lastAttachablePart = geminiPart;
					continue;
				}

				if (!(part instanceof vscode.LanguageModelThinkingPart)) {
					continue;
				}

				const metadata = part.metadata as { type?: string; thoughtSignature?: string } | undefined;
				if (metadata?.type === "retry_notice") {
					continue;
				}

				if (metadata?.type === GEMINI_SIGNATURE_MARKER_TYPE) {
					if (lastAttachablePart && typeof metadata.thoughtSignature === "string") {
						lastAttachablePart.thoughtSignature = metadata.thoughtSignature;
					}
					continue;
				}

				const thinkingText = Array.isArray(part.value) ? part.value.join("") : part.value;
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

		if (systemParts.length > 0) {
			this._systemContent = systemParts.join("\n");
		}

		return contents;
	}

	buildRequest(
		model: ModelItem,
		baseUrl: string,
		apiKey: string,
		messages: unknown[],
		options?: ProvideLanguageModelChatResponseOptions
	): PreparedRequest {
		const body: Record<string, unknown> = {
			contents: messages,
		};

		if (this._systemContent) {
			body.systemInstruction = {
				role: "user",
				parts: [{ text: this._systemContent }],
			};
		}

		const genConfig: Record<string, unknown> = {};
		if (model.temperature !== undefined && model.temperature !== null) {
			genConfig.temperature = model.temperature;
		}
		if (model.top_p !== undefined && model.top_p !== null) {
			genConfig.topP = model.top_p;
		}
		const maxOutput = (model as any).maxOutputTokens;
		if (maxOutput !== undefined) { genConfig.maxOutputTokens = maxOutput; }
		const topK = (model as any).topK;
		if (topK !== undefined) { genConfig.topK = topK; }
		const topP = (model as any).topP;
		if (topP !== undefined) { genConfig.topP = topP; }

		if (Object.keys(genConfig).length > 0) {
			body.generationConfig = genConfig;
		}

		const thinkingConfig = (model as any).thinkingConfig;
		if (thinkingConfig && typeof thinkingConfig === "object") {
			body.thinkingConfig = thinkingConfig;
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

		const normalized = baseUrl.replace(/\/+$/, "");
		const url = `${normalized}/v1beta/models/${model.id}:streamGenerateContent?alt=sse`;
		const headers = BaseAdapter.prepareHeaders(apiKey, "gemini", model.headers);

		return { url, headers, body };
	}

	async processStream(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<StreamResult> {
		const reader = responseBody.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				if (token.isCancellationRequested) { break; }
				const { done, value } = await reader.read();
				if (done) { break; }

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (!line.startsWith("data:")) { continue; }
					const data = line.slice(5).trim();
					if (!data || data === "[DONE]") { continue; }

					try {
						const parsed = JSON.parse(data) as Record<string, unknown>;
						this.processGeminiChunk(parsed, progress);
					} catch {
						// ignore malformed chunk
					}
				}
			}
		} catch (error) {
			this.markStreamInterruptedDuringThinking();
			throw error;
		} finally {
			reader.releaseLock();
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
					this._hasEmittedAssistantText = true;
					if (thoughtSignature) {
						this.reportThoughtSignatureMarker(thoughtSignature, progress);
					}
				}
				continue;
			}

			if (functionCall && typeof functionCall.name === "string") {
				this.reportEndThinking(progress);
				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}

				const callId = typeof functionCall.id === "string"
					? functionCall.id
					: `call_${Date.now()}_${this._directToolCallSequence}`;
				const args = functionCall.args && typeof functionCall.args === "object"
					? functionCall.args as Record<string, unknown>
					: {};

				progress.report(new LanguageModelToolCallPart(callId, functionCall.name, args));
				this._completedToolCallIndices.add(this._directToolCallSequence++);
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
