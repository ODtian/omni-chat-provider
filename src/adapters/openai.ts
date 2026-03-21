// ──────────────────────────────────────────────────────────────
// OpenAI Chat Completions adapter
// ──────────────────────────────────────────────────────────────
import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart2,
	LanguageModelTextPart,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type { ModelItem } from "../types";
import { BaseAdapter, type PreparedRequest, type StreamResult } from "./base";
import {
	mapRole, isImageMimeType, createDataUrl,
	isToolResultPart, collectToolResultText,
} from "../utils/helpers";
import { convertToolsToOpenAI } from "../utils/toolConverter";

interface OpenAIMessage {
	role: "user" | "assistant" | "system";
	content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>;
	tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
	tool_call_id?: string;
	reasoning_content?: string;
}

export class OpenAIAdapter extends BaseAdapter {
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): OpenAIMessage[] {
		const out: OpenAIMessage[] = [];

		for (const m of messages) {
			const role = mapRole(m);
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
			const toolResults: { callId: string; content: string }[] = [];
			const thinkingParts: string[] = [];

			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				} else if (part instanceof vscode.LanguageModelDataPart && isImageMimeType(part.mimeType)) {
					imageParts.push(part);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					const id = part.callId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					let args = "{}";
					try { args = JSON.stringify(part.input ?? {}); } catch { args = "{}"; }
					toolCalls.push({ id, type: "function", function: { name: part.name, arguments: args } });
				} else if (isToolResultPart(part)) {
					const callId = (part as { callId?: string }).callId ?? "";
					const content = collectToolResultText(part as { content?: ReadonlyArray<unknown> });
					toolResults.push({ callId, content });
				} else if (
					part instanceof vscode.LanguageModelThinkingPart &&
					modelConfig.includeReasoningInRequest &&
					(part.metadata as { type?: string } | undefined)?.type !== "retry_notice"
				) {
					const content = Array.isArray(part.value) ? part.value.join("") : part.value;
					thinkingParts.push(content);
				}
			}

			const joinedText = textParts.join("").trim();
			const joinedThinking = thinkingParts.join("").trim();

			if (role === "assistant") {
				const msg: OpenAIMessage = {
					role: "assistant",
					content: joinedText || "",
				};
				if (toolCalls.length > 0) {
					msg.tool_calls = toolCalls;
				}
				if (joinedThinking && modelConfig.includeReasoningInRequest) {
					msg.reasoning_content = joinedThinking;
				}
				out.push(msg);
			}

			for (const tr of toolResults) {
				if (!tr.callId) { continue; }
				out.push({
					role: "assistant" as any,
					content: tr.content || "",
					tool_call_id: tr.callId,
				} as any);
			}

			if (role === "user" || role === "system") {
				if (imageParts.length > 0) {
					const content: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> = [];
					if (joinedText) {
						content.push({ type: "text", text: joinedText });
					}
					for (const img of imageParts) {
						content.push({ type: "image_url", image_url: { url: createDataUrl(img), detail: "auto" } });
					}
					out.push({ role, content });
				} else if (joinedText) {
					out.push({ role, content: joinedText });
				}
			}
		}

		return out;
	}

	buildRequest(
		model: ModelItem,
		baseUrl: string,
		apiKey: string,
		messages: unknown[],
		options?: ProvideLanguageModelChatResponseOptions
	): PreparedRequest {
		const body: Record<string, unknown> = {
			model: model.id,
			messages,
			stream: true,
			stream_options: { include_usage: true },
		};

		// Apply API-native parameters directly from model config
		if (model.temperature !== undefined && model.temperature !== null) {
			body.temperature = model.temperature;
		}
		if (model.top_p !== undefined && model.top_p !== null) {
			body.top_p = model.top_p;
		}

		// OpenAI-specific params (read native names)
		const maxTokens = (model as any).max_completion_tokens ?? (model as any).max_tokens;
		if (maxTokens !== undefined) {
			body.max_completion_tokens = maxTokens;
		}
		if ((model as any).reasoning_effort !== undefined) {
			body.reasoning_effort = (model as any).reasoning_effort;
		}
		if ((model as any).frequency_penalty !== undefined) {
			body.frequency_penalty = (model as any).frequency_penalty;
		}
		if ((model as any).presence_penalty !== undefined) {
			body.presence_penalty = (model as any).presence_penalty;
		}

		// Tools
		const toolConfig = convertToolsToOpenAI(options);
		if (toolConfig.tools) {
			body.tools = toolConfig.tools;
		}
		if (toolConfig.tool_choice) {
			body.tool_choice = toolConfig.tool_choice;
		}

		// Extra pass-through parameters
		if (model.extra && typeof model.extra === "object") {
			for (const [key, value] of Object.entries(model.extra)) {
				if (value !== undefined) {
					body[key] = value;
				}
			}
		}

		const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
		const headers = BaseAdapter.prepareHeaders(apiKey, model.apiMode ?? "openai", model.headers);

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
					if (data === "[DONE]") {
						await this.flushToolCallBuffers(progress, false);
						continue;
					}

					try {
						const parsed = JSON.parse(data);
						await this.processChunk(parsed, progress);
					} catch {
						// Ignore malformed SSE lines
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

	private async processChunk(
		chunk: Record<string, unknown>,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		const choices = chunk.choices as Array<{
			delta?: {
				content?: string;
				reasoning_content?: string;
				tool_calls?: Array<{
					index: number;
					id?: string;
					function?: { name?: string; arguments?: string };
				}>;
			};
		}>;

		if (!Array.isArray(choices) || choices.length === 0) {
			return;
		}

		const delta = choices[0]?.delta;
		if (!delta) {
			return;
		}

		// Reasoning / thinking content
		if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
			this.bufferThinkingContent(delta.reasoning_content, progress);
			return;
		}

		// Tool calls
		if (Array.isArray(delta.tool_calls)) {
			this.reportEndThinking(progress);

			if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
				progress.report(new LanguageModelTextPart(" "));
				this._emittedBeginToolCallsHint = true;
			}

			for (const tc of delta.tool_calls) {
				const idx = tc.index ?? 0;
				if (this._completedToolCallIndices.has(idx)) { continue; }

				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
				if (!buf.id && tc.id) { buf.id = tc.id; }
				if (!buf.name && tc.function?.name) { buf.name = tc.function.name; }
				if (tc.function?.arguments) { buf.args += tc.function.arguments; }
				this._toolCallBuffers.set(idx, buf);

				await this.tryEmitBufferedToolCall(idx, progress);
			}
			return;
		}

		// Text content
		if (typeof delta.content === "string") {
			this.reportEndThinking(progress);

			const text = delta.content;
			const xmlRes = this.processXmlThinkBlocks(text, progress);
			if (!xmlRes.emittedAny) {
				const res = this.processTextContent(text, progress);
				if (res.emittedAny) {
					this._hasEmittedAssistantText = true;
				}
			}
		}
	}
}
