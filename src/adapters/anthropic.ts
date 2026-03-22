// ──────────────────────────────────────────────────────────────
// Anthropic Messages API adapter
// ──────────────────────────────────────────────────────────────
import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart2,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type { AnthropicModelItem, ModelItem } from "../types";
import { BaseAdapter, type ConvertedMessages, type PreparedRequest, type StreamResult } from "./base";
import {
	normalizeChatMessage,
} from "../utils/helpers";
import { convertToolsToOpenAI } from "../utils/toolConverter";

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string;
}

export class AnthropicAdapter extends BaseAdapter {
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): ConvertedMessages<AnthropicMessage> {
		const out: AnthropicMessage[] = [];
		let systemContent: string | undefined;
		for (const m of messages) {
			const normalized = normalizeChatMessage(m, {
				includeReasoningInRequest: modelConfig.includeReasoningInRequest,
			});
			if (normalized.role === "system" && normalized.joinedText) {
				systemContent = normalized.joinedText;
				continue;
			}
			if (normalized.joinedText) {
				out.push({
					role: normalized.role === "system" ? "user" : normalized.role,
					content: normalized.joinedText,
				});
			}
		}
		return { messages: out, systemContent };
	}

	buildRequest(
		model: ModelItem,
		baseUrl: string,
		apiKey: string,
		converted: ConvertedMessages<AnthropicMessage>,
		options?: ProvideLanguageModelChatResponseOptions
	): PreparedRequest {
		const anthropicModel = model as AnthropicModelItem;
		const { messages, systemContent } = converted;
		const body: Record<string, unknown> = {
			model: model.id,
			messages,
			stream: true,
		};

		if (systemContent) {
			body.system = systemContent;
		}

		// Anthropic-native parameters
		const maxTokens = anthropicModel.max_tokens;
		if (maxTokens !== undefined) {
			body.max_tokens = maxTokens;
		} else {
			body.max_tokens = 4096; // Anthropic requires max_tokens
		}

		if (model.temperature !== undefined && model.temperature !== null) {
			body.temperature = model.temperature;
		}
		if (model.top_p !== undefined && model.top_p !== null) {
			body.top_p = model.top_p;
		}

		const topK = anthropicModel.top_k;
		if (topK !== undefined) { body.top_k = topK; }

		const thinking = anthropicModel.thinking;
		if (thinking && typeof thinking === "object") {
			body.thinking = thinking;
		}

		// Tools
		const toolConfig = convertToolsToOpenAI(options);
		if (toolConfig.tools) {
			body.tools = toolConfig.tools.map((t) => ({
				name: t.function.name,
				description: t.function.description,
				input_schema: t.function.parameters,
			}));
		}

		// Extra
		if (model.extra) {
			for (const [key, value] of Object.entries(model.extra)) {
				if (value !== undefined) { body[key] = value; }
			}
		}

		const normalized = baseUrl.replace(/\/+$/, "");
		const url = normalized.endsWith("/v1")
			? `${normalized}/messages`
			: `${normalized}/v1/messages`;
		const headers = BaseAdapter.prepareHeaders(apiKey, "anthropic", model.headers);

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
					this.processAnthropicEvent(parsed, progress);
				} catch { /* ignore */ }
			});
		} finally {
			this.reportEndThinking(progress);
		}
		return {};
	}

	private processAnthropicEvent(
		event: Record<string, unknown>,
		progress: Progress<LanguageModelResponsePart2>
	): void {
		const eventType = typeof event.type === "string" ? event.type : "";

		switch (eventType) {
			case "content_block_delta": {
				const delta = event.delta as Record<string, unknown> | undefined;
				if (!delta) { return; }

				if (delta.type === "text_delta" && typeof delta.text === "string") {
					this.reportEndThinking(progress);
					const res = this.processTextContent(delta.text, progress);
					if (res.emittedAny) { this.markAssistantTextEmitted(); }
				} else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
					this.bufferThinkingContent(delta.thinking, progress);
				} else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
					// Tool call argument streaming
					const idx = (event.index as number) ?? 0;
					const buf = this.getOrCreateToolCallBuffer(idx);
					buf.args += delta.partial_json;
					this.setToolCallBuffer(idx, buf);
				}
				return;
			}

			case "content_block_start": {
				const block = event.content_block as Record<string, unknown> | undefined;
				if (block?.type === "tool_use") {
					this.reportEndThinking(progress);
					this.emitBeginToolCallsHint(progress);
					const idx = (event.index as number) ?? 0;
					this.setToolCallBuffer(idx, {
						id: typeof block.id === "string" ? block.id : undefined,
						name: typeof block.name === "string" ? block.name : undefined,
						args: "",
					});
				}
				return;
			}

			case "content_block_stop": {
				const idx = (event.index as number) ?? 0;
				this.tryEmitBufferedToolCall(idx, progress);
				return;
			}

			case "message_stop": {
				this.flushToolCallBuffers(progress, false);
				this.reportEndThinking(progress);
				return;
			}
		}
	}
}
