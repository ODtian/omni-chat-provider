// ──────────────────────────────────────────────────────────────
// OpenAI Responses API adapter (stub)
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
import { convertToolsToResponses } from "../utils/toolConverter";

// ── Responses API types ──

interface ResponsesContentPart {
	type: "input_text" | "input_image" | "output_text" | "summary_text";
	text?: string;
	image_url?: string;
	detail?: "auto";
}

interface ResponsesInputMessage {
	role: "user" | "assistant" | "system";
	content: ResponsesContentPart[];
	type?: "message";
	id?: string;
	status?: "completed" | "incomplete";
}

interface ResponsesFunctionCall {
	type: "function_call";
	id: string;
	call_id: string;
	name: string;
	arguments: string;
	status: "completed";
}

interface ResponsesFunctionCallOutput {
	type: "function_call_output";
	call_id: string;
	output: string;
	id: string;
	status: "completed";
}

interface ResponsesReasoning {
	type: "reasoning";
	summary: ResponsesContentPart[];
	id: string;
	status: "completed";
}

type ResponsesInputItem =
	| ResponsesInputMessage
	| ResponsesFunctionCall
	| ResponsesFunctionCallOutput
	| ResponsesReasoning;

export class OpenAIResponsesAdapter extends BaseAdapter {
	private _responseId: string | null = null;

	get responseId(): string | null {
		return this._responseId;
	}

	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): ResponsesInputItem[] {
		const out: ResponsesInputItem[] = [];

		for (const m of messages) {
			const role = mapRole(m);
			const textParts: string[] = [];
			const imageParts: vscode.LanguageModelDataPart[] = [];
			const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
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
					toolCalls.push({ id, name: part.name, arguments: args });
				} else if (isToolResultPart(part)) {
					toolResults.push({
						callId: (part as { callId?: string }).callId ?? "",
						content: collectToolResultText(part as { content?: ReadonlyArray<unknown> }),
					});
				} else if (part instanceof vscode.LanguageModelThinkingPart && modelConfig.includeReasoningInRequest) {
					thinkingParts.push(Array.isArray(part.value) ? part.value.join("") : part.value);
				}
			}

			const joinedText = textParts.join("").trim();
			const joinedThinking = thinkingParts.join("").trim();

			if (role === "assistant") {
				if (joinedText) {
					out.push({
						role: "assistant",
						content: [{ type: "output_text", text: joinedText }],
						type: "message",
						id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						status: "completed",
					});
				}
				if (joinedThinking) {
					out.push({
						summary: [{ type: "summary_text", text: joinedThinking }],
						type: "reasoning",
						id: `tk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
						status: "completed",
					});
				}
				for (const tc of toolCalls) {
					out.push({
						type: "function_call",
						id: `fc_${tc.id}`,
						call_id: tc.id,
						name: tc.name,
						arguments: tc.arguments,
						status: "completed",
					});
				}
			}

			for (const tr of toolResults) {
				if (!tr.callId) { continue; }
				out.push({
					type: "function_call_output",
					call_id: tr.callId,
					output: tr.content || "",
					id: `fco_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					status: "completed",
				});
			}

			if (role === "user") {
				const contentArray: ResponsesContentPart[] = [];
				if (joinedText) {
					contentArray.push({ type: "input_text", text: joinedText });
				}
				for (const img of imageParts) {
					contentArray.push({ type: "input_image", image_url: createDataUrl(img), detail: "auto" });
				}
				if (contentArray.length > 0) {
					out.push({
						role: "user",
						content: contentArray,
						type: "message",
						status: "completed",
					});
				}
			}

			if (role === "system" && joinedText) {
				this._systemContent = joinedText;
			}
		}

		// Mark last user message as incomplete
		if (out.length > 0) {
			const last = out[out.length - 1] as unknown as Record<string, unknown>;
			if (last.type === "message" && last.role === "user") {
				last.status = "incomplete";
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
			input: messages,
			stream: true,
		};

		// System content → instructions
		if (this._systemContent) {
			body.instructions = this._systemContent;
		}

		// Responses-native parameters
		if (model.temperature !== undefined && model.temperature !== null) {
			body.temperature = model.temperature;
		}
		if (model.top_p !== undefined && model.top_p !== null) {
			body.top_p = model.top_p;
		}
		const maxOutput = (model as any).max_output_tokens;
		if (maxOutput !== undefined) {
			body.max_output_tokens = maxOutput;
		}

		// Reasoning config
		const reasoning = (model as any).reasoning;
		if (reasoning && typeof reasoning === "object") {
			body.reasoning = reasoning;
		}

		// Tools
		const toolConfig = convertToolsToResponses(options);
		if (toolConfig.tools) { body.tools = toolConfig.tools; }
		if (toolConfig.tool_choice) { body.tool_choice = toolConfig.tool_choice; }

		// Prompt cache key
		if (!body.prompt_cache_key) {
			body.prompt_cache_key = `omnichat-${model.id}`;
		}

		// Extra
		if (model.extra && typeof model.extra === "object") {
			for (const [key, value] of Object.entries(model.extra)) {
				if (value !== undefined) {
					if (key === "reasoning" && typeof value === "object" && typeof body.reasoning === "object") {
						body.reasoning = { ...(body.reasoning as Record<string, unknown>), ...(value as Record<string, unknown>) };
					} else {
						body[key] = value;
					}
				}
			}
		}

		const url = `${baseUrl.replace(/\/+$/, "")}/responses`;
		const headers = BaseAdapter.prepareHeaders(apiKey, model.apiMode ?? "openai-responses", model.headers);

		return { url, headers, body };
	}

	async processStream(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<StreamResult> {
		this._responseId = null;
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
						const parsed = JSON.parse(data) as Record<string, unknown>;
						await this.processEvent(parsed, progress);
					} catch { /* ignore malformed */ }
				}
			}
		} finally {
			reader.releaseLock();
			this.reportEndThinking(progress);
		}

		return { responseId: this._responseId ?? undefined };
	}

	private async processEvent(
		event: Record<string, unknown>,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		const eventType = typeof event.type === "string" ? event.type : "";
		if (!eventType) { return; }

		this.captureResponseId(event);

		switch (eventType) {
			case "error":
				console.error("[OmniChat] Responses API error:", JSON.stringify(event));
				return;

			case "response.output_text.delta":
			case "response.refusal.delta": {
				this._hasEmittedText = false;
				const delta = this.coerceText(event.delta);
				this.processOutputText(delta, progress);
				return;
			}

			case "response.output_text.done": {
				if (this._hasEmittedText) { this._hasEmittedText = false; return; }
				this.processOutputText(this.coerceText(event.text), progress);
				return;
			}

			case "response.reasoning.delta":
			case "response.reasoning_text.delta":
			case "response.reasoning_summary.delta":
			case "response.reasoning_summary_text.delta":
			case "response.thinking.delta":
			case "response.thinking_summary.delta":
			case "response.thought.delta":
			case "response.thought_summary.delta": {
				this._hasEmittedThinking = false;
				this.processReasoningText(event, progress);
				return;
			}

			case "response.reasoning.done":
			case "response.reasoning_text.done":
			case "response.reasoning_summary.done":
			case "response.reasoning_summary_text.done":
			case "response.thinking.done":
			case "response.thinking_summary.done":
			case "response.thought.done":
			case "response.thought_summary.done": {
				if (this._hasEmittedThinking) { this.reportEndThinking(progress); this._hasEmittedThinking = false; return; }
				this.processReasoningText(event, progress);
				this.reportEndThinking(progress);
				return;
			}

			case "response.function_call_arguments.delta":
			case "response.function_call_arguments.done": {
				this.reportEndThinking(progress);
				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}

				const idx = (event.output_index as number) ?? 0;
				if (this._completedToolCallIndices.has(idx)) { return; }

				const callId = this.getCallId(event);
				const name = typeof event.name === "string" ? event.name : "";
				const chunk = eventType.endsWith(".delta")
					? (typeof event.delta === "string" ? event.delta : "")
					: (typeof event.arguments === "string" ? event.arguments : "");

				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
				if (!buf.id && callId) { buf.id = callId; }
				if (!buf.name && name) { buf.name = name; }
				if (eventType.endsWith(".delta")) {
					if (chunk) { buf.args += chunk; }
				} else {
					buf.args = chunk;
				}
				this._toolCallBuffers.set(idx, buf);

				await this.tryEmitBufferedToolCall(idx, progress);
				if (eventType.endsWith(".done")) {
					await this.flushToolCallBuffers(progress, true);
				}
				return;
			}

			case "response.output_item.added":
			case "response.output_item.done": {
				const item = event.item && typeof event.item === "object"
					? (event.item as Record<string, unknown>)
					: null;
				if (!item || item.type !== "function_call") { return; }

				this.reportEndThinking(progress);
				if (!this._emittedBeginToolCallsHint && this._hasEmittedAssistantText) {
					progress.report(new vscode.LanguageModelTextPart(" "));
					this._emittedBeginToolCallsHint = true;
				}

				const idx = (event.output_index as number) ?? 0;
				if (this._completedToolCallIndices.has(idx)) { return; }

				const callId = this.getCallId(item);
				const name = typeof item.name === "string" ? item.name : "";
				const args = typeof item.arguments === "string" ? item.arguments : "";

				const buf = this._toolCallBuffers.get(idx) ?? { args: "" };
				if (!buf.id && callId) { buf.id = callId; }
				if (!buf.name && name) { buf.name = name; }
				if (args) { buf.args = args; }
				this._toolCallBuffers.set(idx, buf);

				await this.tryEmitBufferedToolCall(idx, progress);
				if (eventType === "response.output_item.done") {
					await this.flushToolCallBuffers(progress, true);
				}
				return;
			}

			case "response.completed":
			case "response.done": {
				await this.flushToolCallBuffers(progress, false);
				this.reportEndThinking(progress);
				return;
			}
		}
	}

	// ── Helpers ──

	private captureResponseId(event: Record<string, unknown>): void {
		if (this._responseId) { return; }
		const rid = event.response_id;
		if (typeof rid === "string" && rid.trim()) { this._responseId = rid; return; }
		const resp = event.response;
		if (resp && typeof resp === "object" && !Array.isArray(resp)) {
			const id = (resp as Record<string, unknown>).id;
			if (typeof id === "string" && id.trim()) { this._responseId = id; }
		}
	}

	private coerceText(value: unknown): string {
		if (typeof value === "string") { return value; }
		if (value && typeof value === "object") {
			const obj = value as Record<string, unknown>;
			for (const key of ["text", "thinking", "reasoning", "summary", "value"]) {
				if (typeof obj[key] === "string") { return obj[key] as string; }
			}
		}
		return "";
	}

	private processOutputText(text: string, progress: Progress<LanguageModelResponsePart2>): void {
		if (!text) { return; }
		const xmlRes = this.processXmlThinkBlocks(text, progress);
		if (!xmlRes.emittedAny) {
			this.reportEndThinking(progress);
			const res = this.processTextContent(text, progress);
			if (res.emittedAny) {
				this._hasEmittedAssistantText = true;
				this._hasEmittedText = true;
			}
		}
	}

	private processReasoningText(event: Record<string, unknown>, progress: Progress<LanguageModelResponsePart2>): void {
		const candidates = [
			this.coerceText(event.delta),
			this.coerceText(event.text),
			this.coerceText(event.reasoning),
			this.coerceText(event.summary),
		].filter(Boolean);

		for (const chunk of candidates) {
			const v = chunk.trim().toLowerCase();
			if (["high", "medium", "low", "minimal", "auto", "none", "detailed", "concise"].includes(v)) {
				continue;
			}
			this.bufferThinkingContent(chunk, progress);
			break;
		}
	}

	private getCallId(event: Record<string, unknown>): string {
		const raw = event.call_id ?? event.callId ?? event.id ?? event.item_id;
		return typeof raw === "string" ? raw : "";
	}
}
