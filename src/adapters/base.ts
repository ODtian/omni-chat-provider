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
import { RetryableHttpError } from "../services/retryService";

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

export interface AdapterContextScope {
	requestInitiator?: string;
	modelId?: string;
	conversationKey?: string;
}

export interface ConvertedMessages<TMessage = unknown> {
	messages: TMessage[];
	systemContent?: string;
}

type StreamLineHandler = (line: string) => void | Promise<void>;

type ToolCallBuffer = { id?: string; name?: string; args: string };

class ToolCallState {
	readonly buffers = new Map<number, ToolCallBuffer>();
	readonly completedIndices = new Set<number>();
	hasEmittedAssistantText = false;
	hasEmittedText = false;
	emittedBeginToolCallsHint = false;

	hasCompleted(index: number): boolean {
		return this.completedIndices.has(index);
	}

	getOrCreateBuffer(index: number): ToolCallBuffer {
		return this.buffers.get(index) ?? { args: "" };
	}

	setBuffer(index: number, buffer: ToolCallBuffer): void {
		this.buffers.set(index, buffer);
	}

	markCompleted(index: number): void {
		this.completedIndices.add(index);
	}
}

class ThinkingState {
	hasEmittedThinking = false;
	currentId: string | null = null;
	buffer = "";
	flushTimer: NodeJS.Timeout | null = null;
	lastStreamInterruptedDuringThinking = false;

	ensureSession(): string {
		this.hasEmittedThinking = true;
		if (!this.currentId) {
			this.currentId = `thinking_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		}
		return this.currentId;
	}

	appendBuffer(text: string): void {
		this.buffer += text;
	}

	hasBuffer(): boolean {
		return this.buffer.length > 0;
	}

	clearBuffer(): void {
		this.buffer = "";
	}

	hasFlushTimer(): boolean {
		return !!this.flushTimer;
	}

	scheduleFlush(callback: () => void, delayMs: number): void {
		this.flushTimer = setTimeout(callback, delayMs);
	}

	clearFlushTimer(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}

	reset(): void {
		this.currentId = null;
		this.clearBuffer();
		this.clearFlushTimer();
	}

	hasActive(): boolean {
		return !!this.currentId;
	}

	markInterrupted(): void {
		this.lastStreamInterruptedDuringThinking = true;
	}
}

class XmlThinkState {
	active = false;
	detectionAttempted = false;

	markDetectionAttempted(): void {
		this.detectionAttempted = true;
	}
}

/**
 * Base class for all API adapters.
 *
 * Each adapter handles message conversion, request body construction,
 * and SSE stream processing for a specific API format.
 */
export abstract class BaseAdapter {
	private readonly _toolCallState = new ToolCallState();
	private readonly _thinkingState = new ThinkingState();
	private readonly _xmlThinkState = new XmlThinkState();

	/**
	 * Returns true if any text, thinking, or tool call has been emitted.
	 * Used to determine if the response was completely empty.
	 */
	public get hasEmittedAnyContent(): boolean {
		return this._toolCallState.hasEmittedText || this._thinkingState.hasEmittedThinking || this._toolCallState.completedIndices.size > 0;
	}

	/**
	 * Returns true if any non-thinking response content has been emitted.
	 * Thinking-only output should still be considered retryable empty output.
	 */
	public get hasEmittedResponseContent(): boolean {
		return this._toolCallState.hasEmittedText || this._toolCallState.completedIndices.size > 0;
	}

	public get lastStreamInterruptedDuringThinking(): boolean {
		return this._thinkingState.lastStreamInterruptedDuringThinking;
	}

	protected hasCompletedToolCall(index: number): boolean {
		return this._toolCallState.hasCompleted(index);
	}

	protected getOrCreateToolCallBuffer(index: number): ToolCallBuffer {
		return this._toolCallState.getOrCreateBuffer(index);
	}

	protected setToolCallBuffer(index: number, buffer: ToolCallBuffer): void {
		this._toolCallState.setBuffer(index, buffer);
	}

	protected markToolCallCompleted(index: number): void {
		this._toolCallState.markCompleted(index);
	}

	protected markAssistantTextEmitted(): void {
		this._toolCallState.hasEmittedAssistantText = true;
	}

	protected shouldEmitBeginToolCallsHint(): boolean {
		return !this._toolCallState.emittedBeginToolCallsHint && this._toolCallState.hasEmittedAssistantText;
	}

	protected emitBeginToolCallsHint(progress: Progress<LanguageModelResponsePart2>): void {
		if (!this.shouldEmitBeginToolCallsHint()) {
			return;
		}

		progress.report(new LanguageModelTextPart(" "));
		this._toolCallState.emittedBeginToolCallsHint = true;
	}

	protected markThinkingEmitted(value: boolean): void {
		this._thinkingState.hasEmittedThinking = value;
	}

	protected hasThinkingEmitted(): boolean {
		return this._thinkingState.hasEmittedThinking;
	}

	protected ensureThinkingSession(): string {
		return this._thinkingState.ensureSession();
	}

	protected appendThinkingBuffer(text: string): void {
		this._thinkingState.appendBuffer(text);
	}

	protected hasThinkingBuffer(): boolean {
		return this._thinkingState.hasBuffer();
	}

	protected getThinkingBuffer(): string {
		return this._thinkingState.buffer;
	}

	protected clearThinkingBuffer(): void {
		this._thinkingState.clearBuffer();
	}

	protected hasThinkingFlushTimer(): boolean {
		return this._thinkingState.hasFlushTimer();
	}

	protected scheduleThinkingFlush(
		callback: () => void,
		delayMs: number
	): void {
		this._thinkingState.scheduleFlush(callback, delayMs);
	}

	protected clearThinkingFlushTimer(): void {
		this._thinkingState.clearFlushTimer();
	}

	protected resetThinkingState(): void {
		this._thinkingState.reset();
	}

	protected hasActiveThinking(): boolean {
		return this._thinkingState.hasActive();
	}

	protected markStreamInterruptedDuringThinkingState(): void {
		this._thinkingState.markInterrupted();
	}

	protected isXmlThinkActive(): boolean {
		return this._xmlThinkState.active;
	}

	protected setXmlThinkActive(value: boolean): void {
		this._xmlThinkState.active = value;
	}

	protected hasAttemptedXmlThinkDetection(): boolean {
		return this._xmlThinkState.detectionAttempted;
	}

	protected markXmlThinkDetectionAttempted(): void {
		this._xmlThinkState.markDetectionAttempted();
	}

	/**
	 * Convert VS Code chat messages to API-specific format.
	 */
	abstract convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		modelConfig: { includeReasoningInRequest: boolean }
	): ConvertedMessages;

	/**
	 * Build the complete request (url + headers + body) for this API.
	 */
	abstract buildRequest(
		model: ModelItem,
		baseUrl: string,
		apiKey: string,
		converted: ConvertedMessages,
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

	prepareRequestScope(_scope: AdapterContextScope): void {
		// default no-op
	}

	handleRequestError(_error: unknown): { retryWithFreshRequest: boolean } {
		return { retryWithFreshRequest: false };
	}

	commitStreamResult(_result: StreamResult): void {
		// default no-op
	}

	protected isInvalidPreviousResponseError(error: unknown): boolean {
		if (!(error instanceof RetryableHttpError)) {
			return false;
		}

		if (![400, 404].includes(error.statusCode)) {
			return false;
		}

		const message = error.message.toLowerCase();
		return [
			"previous_response_id",
			"previous response",
			"not found",
			"expired",
			"invalid",
		].some((keyword) => message.includes(keyword));
	}

	protected async processSseStream(
		body: ReadableStream<Uint8Array>,
		token: CancellationToken,
		onData: StreamLineHandler,
		onDone?: () => void | Promise<void>
	): Promise<void> {
		await this.processDelimitedStream(body, token, "\n", async (line) => {
			if (!line.startsWith("data:")) {
				return;
			}

			const data = line.slice(5).trim();
			if (data === "[DONE]") {
				await onDone?.();
				return;
			}

			if (!data) {
				return;
			}

			await onData(data);
		});
	}

	protected async processJsonlStream(
		body: ReadableStream<Uint8Array>,
		token: CancellationToken,
		onLine: StreamLineHandler
	): Promise<void> {
		await this.processDelimitedStream(body, token, "\n", async (line) => {
			const trimmed = line.trim();
			if (!trimmed) {
				return;
			}

			await onLine(trimmed);
		});
	}

	// ── Shared tool call logic ──

	protected async tryEmitBufferedToolCall(
		index: number,
		progress: Progress<LanguageModelResponsePart2>
	): Promise<void> {
		const buf = this._toolCallState.buffers.get(index);
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
		this._toolCallState.buffers.delete(index);
		this.markToolCallCompleted(index);
	}

	protected async flushToolCallBuffers(
		progress: Progress<LanguageModelResponsePart2>,
		throwOnInvalid: boolean
	): Promise<void> {
		if (this._toolCallState.buffers.size === 0) {
			return;
		}
		for (const [idx, buf] of Array.from(this._toolCallState.buffers.entries())) {
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
			this._toolCallState.buffers.delete(idx);
			this.markToolCallCompleted(idx);
		}
	}

	// ── Shared thinking logic ──

	protected bufferThinkingContent(
		text: string,
		progress: Progress<LanguageModelResponsePart2>
	): void {
		this.ensureThinkingSession();
		this.appendThinkingBuffer(text);
		if (!this.hasThinkingFlushTimer()) {
			this.scheduleThinkingFlush(() => {
				this.flushThinkingBuffer(progress);
			}, 100);
		}
	}

	protected flushThinkingBuffer(progress: Progress<LanguageModelResponsePart2>): void {
		this.clearThinkingFlushTimer();
		if (this.hasThinkingBuffer() && this._thinkingState.currentId) {
			const text = this.getThinkingBuffer();
			this.clearThinkingBuffer();
			progress.report(new LanguageModelThinkingPart(text, this._thinkingState.currentId));
		}
	}

	protected reportEndThinking(progress: Progress<LanguageModelResponsePart2>): void {
		if (!this.hasActiveThinking()) {
			return;
		}
		const thinkingId = this._thinkingState.currentId ?? undefined;
		try {
			this.flushThinkingBuffer(progress);
			progress.report(new LanguageModelThinkingPart("", thinkingId));
		} catch (e) {
			console.error("[OmniChat] Failed to end thinking:", e);
		}
		this.resetThinkingState();
	}

	protected markStreamInterruptedDuringThinking(): void {
		if (this.hasActiveThinking() || this.hasThinkingBuffer() || this.isXmlThinkActive()) {
			this.markStreamInterruptedDuringThinkingState();
		}
	}

	// ── Shared text processing ──

	protected processTextContent(
		input: string,
		progress: Progress<LanguageModelResponsePart2>
	): { emittedAny: boolean } {
		if (input.length > 0) {
			this._toolCallState.hasEmittedText = true;
			progress.report(new LanguageModelTextPart(input));
			return { emittedAny: true };
		}
		return { emittedAny: false };
	}

	protected processXmlThinkBlocks(
		input: string,
		progress: Progress<LanguageModelResponsePart2>
	): { emittedAny: boolean } {
		if (this.hasAttemptedXmlThinkDetection() && !this.isXmlThinkActive()) {
			return { emittedAny: false };
		}

		const THINK_START = "<think>";
		const THINK_END = "</think>";
		let data = input;
		let emittedAny = false;

		while (data.length > 0) {
			if (!this.isXmlThinkActive()) {
				const startIdx = data.indexOf(THINK_START);
				if (startIdx === -1) {
					this.markXmlThinkDetectionAttempted();
					break;
				}
				emittedAny = true;
				this.setXmlThinkActive(true);
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
			this.setXmlThinkActive(false);
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

	private async processDelimitedStream(
		body: ReadableStream<Uint8Array>,
		token: CancellationToken,
		delimiter: string,
		onLine: StreamLineHandler
	): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				if (token.isCancellationRequested) {
					break;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split(delimiter);
				buffer = lines.pop() || "";

				for (const line of lines) {
					await onLine(line);
				}
			}
		} catch (error) {
			this.markStreamInterruptedDuringThinking();
			throw error;
		} finally {
			reader.releaseLock();
		}
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
