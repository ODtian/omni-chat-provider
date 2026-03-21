// ──────────────────────────────────────────────────────────────
// Anthropic Messages API adapter (stub — to be filled)
// ──────────────────────────────────────────────────────────────
import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart2,
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

export class AnthropicAdapter extends BaseAdapter {
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): unknown[] {
		// TODO: Full Anthropic message conversion
		// For now, basic conversion similar to OpenAI
		const out: unknown[] = [];
		for (const m of messages) {
			const role = mapRole(m);
			const textParts: string[] = [];
			for (const part of m.content ?? []) {
				if (part instanceof vscode.LanguageModelTextPart) {
					textParts.push(part.value);
				}
			}
			const joinedText = textParts.join("").trim();
			if (role === "system" && joinedText) {
				this._systemContent = joinedText;
				continue;
			}
			if (joinedText) {
				out.push({ role: role === "system" ? "user" : role, content: joinedText });
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
		};

		if (this._systemContent) {
			body.system = this._systemContent;
		}

		// Anthropic-native parameters
		const maxTokens = (model as any).max_tokens;
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

		const topK = (model as any).top_k;
		if (topK !== undefined) { body.top_k = topK; }

		const thinking = (model as any).thinking;
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
					if (data === "[DONE]") { continue; }

					try {
						const parsed = JSON.parse(data) as Record<string, unknown>;
						this.processAnthropicEvent(parsed, progress);
					} catch { /* ignore */ }
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
					if (res.emittedAny) { this._hasEmittedAssistantText = true; }
				} else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
					this.bufferThinkingContent(delta.thinking, progress);
				} else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
					// Tool call argument streaming
					const idx = (event.index as number) ?? 0;
					const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
					buf.args += delta.partial_json;
					this._toolCallBuffers.set(idx, buf);
				}
				return;
			}

			case "content_block_start": {
				const block = event.content_block as Record<string, unknown> | undefined;
				if (block?.type === "tool_use") {
					this.reportEndThinking(progress);
					if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
						progress.report(new vscode.LanguageModelTextPart(" "));
						this._emittedBeginToolCallsHint = true;
					}
					const idx = (event.index as number) ?? 0;
					this._toolCallBuffers.set(idx, {
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
