// ──────────────────────────────────────────────────────────────
// OpenAI Responses API adapter
// ──────────────────────────────────────────────────────────────
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart2,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type { ModelItem, OpenAIResponsesModelItem } from "../types";
import { BaseAdapter, type AdapterContextScope, type ConvertedMessages, type PreparedRequest, type StreamResult } from "./base";
import {
	createDataUrl,
	normalizeChatMessage,
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
	private static readonly _responseStateByKey = new Map<string, string>();
	private static readonly _maxResponseStateEntries = 256;

	private _responseId: string | null = null;
	private _previousResponseId: string | null = null;
	private _requestStateKey: string | null = null;
	private _responsesDeltaEmitted = false;

	get responseId(): string | null {
		return this._responseId;
	}

	setPreviousResponseId(responseId: string | null | undefined): void {
		if (typeof responseId === "string" && responseId.trim()) {
			this._previousResponseId = responseId.trim();
			return;
		}
		this._previousResponseId = null;
	}

	get previousResponseId(): string | null {
		return this._previousResponseId;
	}

	override prepareRequestScope(scope: AdapterContextScope): void {
		const modelId = scope.modelId?.trim();
		const initiator = scope.requestInitiator?.trim() || "unknown";
		const conversationKey = scope.conversationKey?.trim() || "default";
		this._requestStateKey = modelId ? `${modelId}::${conversationKey}::${initiator}` : null;
		this.setPreviousResponseId(
			this._requestStateKey
				? OpenAIResponsesAdapter.getStateValue(this._requestStateKey)
				: null
		);
	}

	override handleRequestError(error: unknown): { retryWithFreshRequest: boolean } {
		if (!this._previousResponseId || !this.isInvalidPreviousResponseError(error)) {
			return { retryWithFreshRequest: false };
		}

		if (this._requestStateKey) {
			OpenAIResponsesAdapter._responseStateByKey.delete(this._requestStateKey);
		}
		this.setPreviousResponseId(null);
		return { retryWithFreshRequest: true };
	}

	override commitStreamResult(result: StreamResult): void {
		if (!this._requestStateKey || !result.responseId) {
			return;
		}
		OpenAIResponsesAdapter.setStateValue(this._requestStateKey, result.responseId);
	}

	private static getStateValue(key: string): string | undefined {
		const value = OpenAIResponsesAdapter._responseStateByKey.get(key);
		if (value === undefined) {
			return undefined;
		}

		// refresh recency
		OpenAIResponsesAdapter._responseStateByKey.delete(key);
		OpenAIResponsesAdapter._responseStateByKey.set(key, value);
		return value;
	}

	private static setStateValue(key: string, value: string): void {
		if (!key || !value) {
			return;
		}

		if (OpenAIResponsesAdapter._responseStateByKey.has(key)) {
			OpenAIResponsesAdapter._responseStateByKey.delete(key);
		}
		OpenAIResponsesAdapter._responseStateByKey.set(key, value);

		while (OpenAIResponsesAdapter._responseStateByKey.size > OpenAIResponsesAdapter._maxResponseStateEntries) {
			const oldestKey = OpenAIResponsesAdapter._responseStateByKey.keys().next().value;
			if (!oldestKey) {
				break;
			}
			OpenAIResponsesAdapter._responseStateByKey.delete(oldestKey);
		}
	}

	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): ConvertedMessages<ResponsesInputItem> {
		const out: ResponsesInputItem[] = [];
		let systemContent: string | undefined;

		for (const m of messages) {
			const normalized = normalizeChatMessage(m, {
				includeReasoningInRequest: modelConfig.includeReasoningInRequest,
			});
			const role = normalized.role;
			const joinedText = normalized.joinedText;
			const joinedThinking = normalized.joinedThinking;

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
				for (const tc of normalized.toolCalls) {
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

			for (const tr of normalized.toolResults) {
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
				for (const img of normalized.imageParts) {
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
				systemContent = joinedText;
			}
		}

		// Mark last user message as incomplete
		if (out.length > 0) {
			const last = out[out.length - 1] as unknown as Record<string, unknown>;
			if (last.type === "message" && last.role === "user") {
				last.status = "incomplete";
			}
		}

		return { messages: out, systemContent };
	}

	buildRequest(
		model: ModelItem,
		baseUrl: string,
		apiKey: string,
		converted: ConvertedMessages<ResponsesInputItem>,
		options?: ProvideLanguageModelChatResponseOptions
	): PreparedRequest {
		const responsesModel = model as OpenAIResponsesModelItem;
		const { messages, systemContent } = converted;
		const incrementalInput = this.pickIncrementalInput(messages);
		const usePreviousResponse = !!(this._previousResponseId && incrementalInput.length > 0);
		const body: Record<string, unknown> = {
			model: model.id,
			input: usePreviousResponse ? incrementalInput : messages,
			stream: true,
		};

		if (usePreviousResponse && this._previousResponseId) {
			body.previous_response_id = this._previousResponseId;
		}

		// System content → instructions
		if (systemContent) {
			body.instructions = systemContent;
		}

		// Responses-native parameters
		if (model.temperature !== undefined && model.temperature !== null) {
			body.temperature = model.temperature;
		}
		if (model.top_p !== undefined && model.top_p !== null) {
			body.top_p = model.top_p;
		}
		const maxOutput = responsesModel.max_output_tokens;
		if (maxOutput !== undefined) {
			body.max_output_tokens = maxOutput;
		}

		// Reasoning config
		const reasoning = responsesModel.reasoning;
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

	private pickIncrementalInput(messages: ResponsesInputItem[]): ResponsesInputItem[] {
		let lastUserIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			const item = messages[i];
			if (item.type === "message" && item.role === "user") {
				lastUserIndex = i;
				break;
			}
		}

		if (lastUserIndex < 0) {
			return [];
		}

		return messages.slice(lastUserIndex);
	}

	async processStream(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<StreamResult> {
		this._responseId = null;

		try {
			await this.processSseStream(
				responseBody,
				token,
				async (data) => {
					try {
						const parsed = JSON.parse(data) as Record<string, unknown>;
						await this.processEvent(parsed, progress);
					} catch { /* ignore malformed */ }
				},
				async () => {
					await this.flushToolCallBuffers(progress, false);
				}
			);
		} finally {
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
				this._responsesDeltaEmitted = true;
				const delta = this.coerceText(event.delta);
				this.processOutputText(delta, progress);
				return;
			}

			case "response.output_text.done": {
				if (this._responsesDeltaEmitted) { this._responsesDeltaEmitted = false; return; }
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
				this.markThinkingEmitted(false);
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
				if (this.hasThinkingEmitted()) { this.reportEndThinking(progress); this.markThinkingEmitted(false); return; }
				this.processReasoningText(event, progress);
				this.reportEndThinking(progress);
				return;
			}

			case "response.function_call_arguments.delta":
			case "response.function_call_arguments.done": {
				this.reportEndThinking(progress);
				this.emitBeginToolCallsHint(progress);

				const idx = (event.output_index as number) ?? 0;
				if (this.hasCompletedToolCall(idx)) { return; }

				const callId = this.getCallId(event);
				const name = typeof event.name === "string" ? event.name : "";
				const chunk = eventType.endsWith(".delta")
					? (typeof event.delta === "string" ? event.delta : "")
					: (typeof event.arguments === "string" ? event.arguments : "");

				const buf = this.getOrCreateToolCallBuffer(idx);
				if (!buf.id && callId) { buf.id = callId; }
				if (!buf.name && name) { buf.name = name; }
				if (eventType.endsWith(".delta")) {
					if (chunk) { buf.args += chunk; }
				} else {
					buf.args = chunk;
				}
				this.setToolCallBuffer(idx, buf);

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
				this.emitBeginToolCallsHint(progress);

				const idx = (event.output_index as number) ?? 0;
				if (this.hasCompletedToolCall(idx)) { return; }

				const callId = this.getCallId(item);
				const name = typeof item.name === "string" ? item.name : "";
				const args = typeof item.arguments === "string" ? item.arguments : "";

				const buf = this.getOrCreateToolCallBuffer(idx);
				if (!buf.id && callId) { buf.id = callId; }
				if (!buf.name && name) { buf.name = name; }
				if (args) { buf.args = args; }
				this.setToolCallBuffer(idx, buf);

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
				this.markAssistantTextEmitted();
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
