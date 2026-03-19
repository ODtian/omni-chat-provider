// ──────────────────────────────────────────────────────────────
// ApiAdapter — strategy interface for each API backend
// ──────────────────────────────────────────────────────────────
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart2,
	LanguageModelToolCallPart,
	LanguageModelThinkingPart,
	LanguageModelTextPart,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";
import type { ModelItem } from "../types";
import { tryParseJSON } from "../utils/helpers";
import { Config } from "../config";

/**
 * Result returned after processing a streaming response.
 */
export interface StreamResult {
	/** Responses API response ID for stateful conversations. */
	responseId?: string;
}

/**
 * Prepared request — everything the provider needs to `fetch`.
 */
export interface PreparedRequest {
	url: string;
	headers: Record<string, string>;
	body: unknown;
}

/**
 * Base class for all API adapters.
 *
 * Each adapter handles message conversion, request body construction,
 * and SSE stream processing for a specific API format.
 */
export abstract class BaseAdapter {
	// ── Tool call buffering ──
	protected _toolCallBuffers = new Map<number, { id?: string; name?: string; args: string }>();
	protected _completedToolCallIndices = new Set<number>();
	protected _hasEmittedAssistantText = false;
	protected _hasEmittedText = false;
	protected _emittedBeginToolCallsHint = false;

	// ── Thinking state ──
	protected _hasEmittedThinking = false;
	protected _currentThinkingId: string | null = null;
	protected _thinkingBuffer = "";
	protected _thinkingFlushTimer: NodeJS.Timeout | null = null;

	// ── XML think block parsing ──
	protected _xmlThinkActive = false;
	protected _xmlThinkDetectionAttempted = false;

	// ── System content extracted from messages ──
	protected _systemContent: string | undefined;

	/**
	 * Convert VS Code chat messages to API-specific format.
	 */
	abstract convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): unknown[];

	/**
	 * Build the complete request (url + headers + body) for this API.
	 */
	abstract buildRequest(
		model: ModelItem,
		baseUrl: string,
		apiKey: string,
		messages: unknown[],
		options?: ProvideLanguageModelChatResponseOptions
	): PreparedRequest;

	/**
	 * Process an SSE streaming response.
	 */
	abstract processStream(
		body: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<StreamResult>;

	// ── Shared tool call logic ──

	protected async tryEmitBufferedToolCall(
		index: number,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		const buf = this._toolCallBuffers.get(index);
		if (!buf?.name) {
			return;
		}
		const parsed = tryParseJSON(buf.args);
		if (!parsed.ok) {
			return;
		}
		const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
		const parameters = this.adjustReadFileParameters(buf.name, parsed.value);
		progress.report(new LanguageModelToolCallPart(id, buf.name, parameters));
		this._toolCallBuffers.delete(index);
		this._completedToolCallIndices.add(index);
	}

	protected async flushToolCallBuffers(
		progress: Progress<LanguageModelResponsePart2>,
		throwOnInvalid: boolean
	): Promise<void> {
		if (this._toolCallBuffers.size === 0) {
			return;
		}
		for (const [idx, buf] of Array.from(this._toolCallBuffers.entries())) {
			const argsText = buf.args.trim() || "{}";
			const parsed = tryParseJSON(argsText);
			if (!parsed.ok) {
				if (throwOnInvalid) {
					throw new Error("Invalid JSON for tool call");
				}
				continue;
			}
			const id = buf.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
			const name = buf.name ?? "unknown_tool";
			const parameters = this.adjustReadFileParameters(name, parsed.value);
			progress.report(new LanguageModelToolCallPart(id, name, parameters));
			this._toolCallBuffers.delete(idx);
			this._completedToolCallIndices.add(idx);
		}
	}

	// ── Shared thinking logic ──

	protected bufferThinkingContent(
		text: string,
		progress: Progress<LanguageModelResponsePart2>
	): void {
		this._hasEmittedThinking = true;
		if (!this._currentThinkingId) {
			this._currentThinkingId = `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		}
		this._thinkingBuffer += text;
		if (!this._thinkingFlushTimer) {
			this._thinkingFlushTimer = setTimeout(() => {
				this.flushThinkingBuffer(progress);
			}, 100);
		}
	}

	protected flushThinkingBuffer(progress: Progress<LanguageModelResponsePart2>): void {
		if (this._thinkingFlushTimer) {
			clearTimeout(this._thinkingFlushTimer);
			this._thinkingFlushTimer = null;
		}
		if (this._thinkingBuffer && this._currentThinkingId) {
			const text = this._thinkingBuffer;
			this._thinkingBuffer = "";
			progress.report(new LanguageModelThinkingPart(text, this._currentThinkingId));
		}
	}

	protected reportEndThinking(progress: Progress<LanguageModelResponsePart2>): void {
		if (!this._currentThinkingId) {
			return;
		}
		try {
			this.flushThinkingBuffer(progress);
			progress.report(new LanguageModelThinkingPart("", this._currentThinkingId));
		} catch (e) {
			console.error("[OmniChat] Failed to end thinking:", e);
		}
		this._currentThinkingId = null;
		this._thinkingBuffer = "";
		if (this._thinkingFlushTimer) {
			clearTimeout(this._thinkingFlushTimer);
			this._thinkingFlushTimer = null;
		}
	}

	// ── Shared text processing ──

	protected processTextContent(
		input: string,
		progress: Progress<LanguageModelResponsePart2>
	): { emittedAny: boolean } {
		if (input.length > 0) {
			progress.report(new LanguageModelTextPart(input));
			return { emittedAny: true };
		}
		return { emittedAny: false };
	}

	protected processXmlThinkBlocks(
		input: string,
		progress: Progress<LanguageModelResponsePart2>
	): { emittedAny: boolean } {
		if (this._xmlThinkDetectionAttempted && !this._xmlThinkActive) {
			return { emittedAny: false };
		}

		const THINK_START = "<think>";
		const THINK_END = "</think>";
		let data = input;
		let emittedAny = false;

		while (data.length > 0) {
			if (!this._xmlThinkActive) {
				const startIdx = data.indexOf(THINK_START);
				if (startIdx === -1) {
					this._xmlThinkDetectionAttempted = true;
					break;
				}
				emittedAny = true;
				this._xmlThinkActive = true;
				data = data.slice(startIdx + THINK_START.length);
				continue;
			}

			const endIdx = data.indexOf(THINK_END);
			if (endIdx === -1) {
				this.bufferThinkingContent(data, progress);
				emittedAny = true;
				break;
			}

			this.bufferThinkingContent(data.slice(0, endIdx), progress);
			emittedAny = true;
			this._xmlThinkActive = false;
			data = data.slice(endIdx + THINK_END.length);
		}

		return { emittedAny };
	}

	// ── Helpers ──

	protected adjustReadFileParameters(
		toolName: string,
		parameters: Record<string, unknown>
	): Record<string, unknown> {
		if (toolName !== "read_file") {
			return parameters;
		}
		const defaultLines = Config.getReadFileLines();
		if (defaultLines <= 0) {
			return parameters;
		}
		const startLine = typeof parameters.startLine === "number" ? parameters.startLine : 1;
		const endLine = typeof parameters.endLine === "number" ? parameters.endLine : startLine;
		if (endLine < startLine + defaultLines) {
			return { ...parameters, endLine: startLine + defaultLines };
		}
		return parameters;
	}

	/**
	 * Prepare standard HTTP headers.
	 */
	static prepareHeaders(
		apiKey: string,
		apiMode: string,
		customHeaders?: Record<string, string>
	): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"User-Agent": "omni-chat-provider/0.1.0",
		};

		if (apiMode === "anthropic") {
			headers["x-api-key"] = apiKey;
			headers["anthropic-version"] = "2023-06-01";
		} else if (apiMode === "ollama" && apiKey !== "ollama") {
			headers["Authorization"] = `Bearer ${apiKey}`;
		} else if (apiMode === "gemini") {
			headers["x-goog-api-key"] = apiKey;
			headers["Accept"] = "text/event-stream";
		} else {
			headers["Authorization"] = `Bearer ${apiKey}`;
		}

		if (customHeaders) {
			return { ...headers, ...customHeaders };
		}
		return headers;
	}
}
