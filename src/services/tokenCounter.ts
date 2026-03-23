import * as vscode from "vscode";
import { createByModelName, type TikTokenizer } from "@microsoft/tiktokenizer";

import { Config } from "../config";
import type { ModelItem } from "../types";
import { ApiKeyManager } from "./apiKeyManager";
import { AnthropicAdapter } from "../adapters/anthropic";
import { buildGeminiApiUrl, GeminiAdapter } from "../adapters/gemini";
import { OpenAIResponsesAdapter } from "../adapters/openaiResponses";
import { BaseAdapter } from "../adapters/base";

const tokenizerCache = new Map<string, Promise<TikTokenizer | null>>();
const DEFAULT_TEXT_CHARS_PER_TOKEN = 3.7;
const DEFAULT_IMAGE_TOKEN_COST = 258;
const OPENAI_MESSAGE_OVERHEAD = 4;
const OPENAI_REPLY_PRIMER = 2;
const OPENAI_NAME_OVERHEAD = 1;
const OPENAI_TOOL_OVERHEAD = 12;
const RESPONSES_ITEM_OVERHEAD = 3;

export async function countTokensForInput(options: {
	input: string | vscode.LanguageModelChatRequestMessage;
	keyManager: ApiKeyManager;
	model: ModelItem;
	token: vscode.CancellationToken;
}): Promise<number> {
	const apiMode = options.model.apiMode ?? "openai";

	if (apiMode === "gemini") {
		const remote = await countViaGemini(options);
		if (remote !== undefined) {
			return remote;
		}
	}

	if (apiMode === "anthropic") {
		const remote = await countViaAnthropic(options);
		if (remote !== undefined) {
			return remote;
		}
	}

	if (apiMode === "openai" || apiMode === "openai-responses") {
		return await countWithTiktoken(options.model, options.input, apiMode);
	}

	return estimateGenericTokens(options.input);
}

async function countViaGemini(options: {
	input: string | vscode.LanguageModelChatRequestMessage;
	keyManager: ApiKeyManager;
	model: ModelItem;
	token: vscode.CancellationToken;
}): Promise<number | undefined> {
	const apiKey = await getApiKey(options.keyManager, options.model);
	if (!apiKey) {
		return undefined;
	}

	const adapter = new GeminiAdapter();
	const converted = adapter.convertMessages([toRequestMessage(options.input)], {
		includeReasoningInRequest: false,
	});
	const body: Record<string, unknown> = {
		contents: converted.messages,
	};

	const systemContent = converted.systemContent;
	if (typeof systemContent === "string" && systemContent) {
		body.systemInstruction = {
			parts: [{ text: systemContent }],
		};
	}

	const url = buildGeminiApiUrl(resolveBaseUrl(options.model), options.model.id, "countTokens");
	const response = await fetchWithCancellation(url, {
		method: "POST",
		headers: BaseAdapter.prepareHeaders(apiKey, "gemini", options.model.headers),
		body: JSON.stringify(body),
	}, options.token);

	if (!response?.ok) {
		return undefined;
	}

	const data = await safeJson(response);
	const total = data?.totalTokens ?? data?.total_tokens;
	return typeof total === "number" ? total : undefined;
}

async function countViaAnthropic(options: {
	input: string | vscode.LanguageModelChatRequestMessage;
	keyManager: ApiKeyManager;
	model: ModelItem;
	token: vscode.CancellationToken;
}): Promise<number | undefined> {
	const apiKey = await getApiKey(options.keyManager, options.model);
	if (!apiKey) {
		return undefined;
	}

	const adapter = new AnthropicAdapter();
	const converted = adapter.convertMessages([toRequestMessage(options.input)], {
		includeReasoningInRequest: false,
	});
	const body: Record<string, unknown> = {
		model: options.model.id,
		messages: converted.messages,
	};

	const systemContent = converted.systemContent;
	if (typeof systemContent === "string" && systemContent) {
		body.system = systemContent;
	}

	const normalized = resolveBaseUrl(options.model).replace(/\/+$/, "");
	const url = normalized.endsWith("/v1")
		? `${normalized}/messages/count_tokens`
		: `${normalized}/v1/messages/count_tokens`;
	const response = await fetchWithCancellation(url, {
		method: "POST",
		headers: BaseAdapter.prepareHeaders(apiKey, "anthropic", options.model.headers),
		body: JSON.stringify(body),
	}, options.token);

	if (!response?.ok) {
		return undefined;
	}

	const data = await safeJson(response);
	const total = data?.input_tokens ?? data?.inputTokens;
	return typeof total === "number" ? total : undefined;
}

async function countWithTiktoken(
	model: ModelItem,
	input: string | vscode.LanguageModelChatRequestMessage,
	apiMode: "openai" | "openai-responses"
): Promise<number> {
	const tokenizer = await getTokenizer(model);
	if (!tokenizer) {
		return estimateGenericTokens(input);
	}

	if (typeof input === "string") {
		return tokenizer.encode(input).length;
	}

	if (apiMode === "openai-responses") {
		return countResponsesMessageTokens(tokenizer, input);
	}

	let total = OPENAI_REPLY_PRIMER;
	total += OPENAI_MESSAGE_OVERHEAD;
	for (const part of input.content ?? []) {
		if (part instanceof vscode.LanguageModelTextPart) {
			total += tokenizer.encode(part.value).length;
			continue;
		}
		if (part instanceof vscode.LanguageModelDataPart) {
			total += part.mimeType.startsWith("image/")
				? DEFAULT_IMAGE_TOKEN_COST
				: Math.ceil(part.data.byteLength / DEFAULT_TEXT_CHARS_PER_TOKEN);
			continue;
		}
		if (part instanceof vscode.LanguageModelToolCallPart) {
			const serialized = JSON.stringify({
				name: part.name,
				callId: part.callId,
				input: part.input,
			});
			total += tokenizer.encode(serialized).length + OPENAI_TOOL_OVERHEAD;
			continue;
		}
		if (part instanceof vscode.LanguageModelThinkingPart) {
			const thinkingText = Array.isArray(part.value) ? part.value.join("") : part.value;
			total += tokenizer.encode(thinkingText).length;
			continue;
		}
		try {
			total += tokenizer.encode(JSON.stringify(part)).length;
		} catch {
			total += 8;
		}
	}
	if (typeof input.name === "string" && input.name.trim()) {
		total += OPENAI_NAME_OVERHEAD + tokenizer.encode(input.name).length;
	}
	return total;
}

function countResponsesMessageTokens(
	tokenizer: TikTokenizer,
	input: vscode.LanguageModelChatRequestMessage
): number {
	const adapter = new OpenAIResponsesAdapter();
	const items = adapter.convertMessages([input], { includeReasoningInRequest: true }).messages;
	let total = 0;
	for (const item of items) {
		total += RESPONSES_ITEM_OVERHEAD;
		total += tokenizer.encode(JSON.stringify(item)).length;
	}
	return total;
}

function estimateGenericTokens(input: string | vscode.LanguageModelChatRequestMessage): number {
	if (typeof input === "string") {
		return Math.ceil(input.length / DEFAULT_TEXT_CHARS_PER_TOKEN);
	}

	let total = 6;
	for (const part of input.content ?? []) {
		if (part instanceof vscode.LanguageModelTextPart) {
			total += Math.ceil(part.value.length / DEFAULT_TEXT_CHARS_PER_TOKEN);
		} else if (part instanceof vscode.LanguageModelDataPart) {
			total += part.mimeType.startsWith("image/")
				? DEFAULT_IMAGE_TOKEN_COST
				: Math.ceil(part.data.byteLength / DEFAULT_TEXT_CHARS_PER_TOKEN);
		} else if (part instanceof vscode.LanguageModelThinkingPart) {
			const text = Array.isArray(part.value) ? part.value.join("") : part.value;
			total += Math.ceil(text.length / DEFAULT_TEXT_CHARS_PER_TOKEN);
		} else {
			total += 12;
		}
	}
	return total;
}

async function getTokenizer(model: ModelItem): Promise<TikTokenizer | null> {
	const cacheKey = model.id || model.family || "default";
	if (!tokenizerCache.has(cacheKey)) {
		tokenizerCache.set(cacheKey, createTokenizer(model));
	}
	return await tokenizerCache.get(cacheKey)!;
}

async function createTokenizer(model: ModelItem): Promise<TikTokenizer | null> {
	const candidates = uniqueStrings([
		model.id,
		model.family,
		model.displayName,
		"gpt-4o",
		"gpt-3.5-turbo",
	]);

	for (const candidate of candidates) {
		try {
			return await createByModelName(candidate);
		} catch {
			continue;
		}
	}

	return null;
}

async function getApiKey(
	keyManager: ApiKeyManager,
	model: ModelItem
): Promise<string | undefined> {
	return await keyManager.getKey(model.owned_by, !model.baseUrl);
}

function resolveBaseUrl(model: ModelItem): string {
	return model.baseUrl || Config.getBaseUrl();
}

function toRequestMessage(
	input: string | vscode.LanguageModelChatRequestMessage
): vscode.LanguageModelChatRequestMessage {
	if (typeof input !== "string") {
		return input;
	}

	return new vscode.LanguageModelChatMessage(
		vscode.LanguageModelChatMessageRole.User,
		input
	) as unknown as vscode.LanguageModelChatRequestMessage;
}

async function fetchWithCancellation(
	url: string,
	init: { method?: string; headers?: Record<string, string>; body?: string },
	token: vscode.CancellationToken
): Promise<any | undefined> {
	const AbortControllerCtor = (globalThis as { AbortController?: new () => { abort(): void; signal: unknown } }).AbortController;
	const controller = AbortControllerCtor ? new AbortControllerCtor() : undefined;
	const disposable = token.onCancellationRequested(() => controller?.abort());
	try {
		const fetchFn = (globalThis as { fetch?: (input: string, init?: Record<string, unknown>) => Promise<any> }).fetch;
		if (!fetchFn) {
			return undefined;
		}
		return await fetchFn(url, controller ? { ...init, signal: controller.signal } : init);
	} catch {
		return undefined;
	} finally {
		disposable.dispose();
	}
}

async function safeJson(response: any): Promise<Record<string, unknown> | undefined> {
	try {
		return await response.json() as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function uniqueStrings(values: ReadonlyArray<string | undefined>): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string") {
			continue;
		}
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) {
			continue;
		}
		seen.add(trimmed);
		result.push(trimmed);
	}
	return result;
}
