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

import type { ModelItem, OpenAIModelItem } from "../types";
import { BaseAdapter, type ConvertedMessages, type PreparedRequest, type StreamResult } from "./base";
import {
	createDataUrl,
	normalizeChatMessage,
} from "../utils/helpers";
import { convertToolsToOpenAI } from "../utils/toolConverter";

interface OpenAIMessage {
	role: "user" | "assistant" | "system" | "tool";
	content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>;
	tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
	tool_call_id?: string;
	reasoning_content?: string;
}

export class OpenAIAdapter extends BaseAdapter {
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): ConvertedMessages<OpenAIMessage> {
		const out: OpenAIMessage[] = [];

		for (const m of messages) {
			const normalized = normalizeChatMessage(m, {
				includeReasoningInRequest: modelConfig.includeReasoningInRequest,
			});
			const role = normalized.role;
			const joinedText = normalized.joinedText;
			const joinedThinking = normalized.joinedThinking;

			if (role === "assistant") {
				const msg: OpenAIMessage = {
					role: "assistant",
					content: joinedText || "",
				};
				if (normalized.toolCalls.length > 0) {
					msg.tool_calls = normalized.toolCalls.map((toolCall) => ({
						id: toolCall.id,
						type: "function",
						function: { name: toolCall.name, arguments: toolCall.arguments },
					}));
				}
				if (joinedThinking && modelConfig.includeReasoningInRequest) {
					msg.reasoning_content = joinedThinking;
				}
				out.push(msg);
			}

			for (const tr of normalized.toolResults) {
				if (!tr.callId) { continue; }
				out.push({
					role: "tool",
					content: tr.content || "",
					tool_call_id: tr.callId,
				});
			}

			if (role === "user" || role === "system") {
				if (normalized.imageParts.length > 0) {
					const content: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> = [];
					if (joinedText) {
						content.push({ type: "text", text: joinedText });
					}
					for (const img of normalized.imageParts) {
						content.push({ type: "image_url", image_url: { url: createDataUrl(img), detail: "auto" } });
					}
					out.push({ role, content });
				} else if (joinedText) {
					out.push({ role, content: joinedText });
				}
			}
		}

		return { messages: out };
	}

	buildRequest(
		model: ModelItem,
		baseUrl: string,
		apiKey: string,
		converted: ConvertedMessages<OpenAIMessage>,
		options?: ProvideLanguageModelChatResponseOptions
	): PreparedRequest {
		const openAIModel = model as OpenAIModelItem;
		const messages = converted.messages;
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
		const maxTokens = openAIModel.max_completion_tokens ?? openAIModel.max_tokens;
		if (maxTokens !== undefined) {
			body.max_completion_tokens = maxTokens;
		}
		if (openAIModel.reasoning_effort !== undefined) {
			body.reasoning_effort = openAIModel.reasoning_effort;
		}
		if (openAIModel.frequency_penalty !== undefined) {
			body.frequency_penalty = openAIModel.frequency_penalty;
		}
		if (openAIModel.presence_penalty !== undefined) {
			body.presence_penalty = openAIModel.presence_penalty;
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
		try {
			await this.processSseStream(
				responseBody,
				token,
				async (data) => {
					try {
						const parsed = JSON.parse(data);
						await this.processChunk(parsed, progress);
					} catch {
						// Ignore malformed SSE lines
					}
				},
				async () => {
					await this.flushToolCallBuffers(progress, false);
				}
			);
		} finally {
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
			this.emitBeginToolCallsHint(progress);

			for (const tc of delta.tool_calls) {
				const idx = tc.index ?? 0;
				if (this.hasCompletedToolCall(idx)) { continue; }

				const buf = this.getOrCreateToolCallBuffer(idx);
				if (!buf.id && tc.id) { buf.id = tc.id; }
				if (!buf.name && tc.function?.name) { buf.name = tc.function.name; }
				if (tc.function?.arguments) { buf.args += tc.function.arguments; }
				this.setToolCallBuffer(idx, buf);

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
					this.markAssistantTextEmitted();
				}
			}
		}
	}
}
