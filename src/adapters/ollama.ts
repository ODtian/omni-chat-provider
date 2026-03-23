// ──────────────────────────────────────────────────────────────
// Ollama native API adapter
// ──────────────────────────────────────────────────────────────
import * as vscode from "vscode";
import {
	CancellationToken,
	LanguageModelChatRequestMessage,
	LanguageModelResponsePart2,
	Progress,
	ProvideLanguageModelChatResponseOptions,
} from "vscode";

import type { ModelItem, OllamaModelItem } from "../types";
import { BaseAdapter, type ConvertedMessages, type PreparedRequest, type StreamResult } from "./base";
import { normalizeChatMessage } from "../utils/helpers";

interface OllamaMessage {
	role: "user" | "assistant" | "system";
	content: string;
}

export class OllamaAdapter extends BaseAdapter {
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		_modelConfig: { includeReasoningInRequest: boolean }
	): ConvertedMessages<OllamaMessage> {
		const out: OllamaMessage[] = [];
		for (const m of messages) {
			const normalized = normalizeChatMessage(m);
			if (normalized.joinedText) {
				out.push({ role: normalized.role, content: normalized.joinedText });
			}
		}
		return { messages: out };
	}

	buildRequest(
		model: ModelItem,
		baseUrl: string,
		apiKey: string,
		converted: ConvertedMessages<OllamaMessage>,
		_options?: ProvideLanguageModelChatResponseOptions
	): PreparedRequest {
		const ollamaModel = model as OllamaModelItem;
		const { messages } = converted;
		const body: Record<string, unknown> = {
			model: model.id,
			messages,
			stream: true,
		};

		// Ollama-native options
		const opts: Record<string, unknown> = {};
		if (model.temperature !== undefined && model.temperature !== null) {
			opts.temperature = model.temperature;
		}
		if (model.top_p !== undefined && model.top_p !== null) {
			opts.top_p = model.top_p;
		}
		const numPredict = ollamaModel.num_predict;
		if (numPredict !== undefined) { opts.num_predict = numPredict; }
		const numCtx = ollamaModel.num_ctx;
		if (numCtx !== undefined) { opts.num_ctx = numCtx; }
		const numGpu = ollamaModel.num_gpu;
		if (numGpu !== undefined) { opts.num_gpu = numGpu; }
		const topK = ollamaModel.top_k;
		if (topK !== undefined) { opts.top_k = topK; }
		const minP = ollamaModel.min_p;
		if (minP !== undefined) { opts.min_p = minP; }
		const repeatPenalty = ollamaModel.repeat_penalty;
		if (repeatPenalty !== undefined) { opts.repeat_penalty = repeatPenalty; }

		if (Object.keys(opts).length > 0) {
			body.options = opts;
		}

		if (model.extra) {
			for (const [key, value] of Object.entries(model.extra)) {
				if (value !== undefined) { body[key] = value; }
			}
		}

		const url = `${baseUrl.replace(/\/+$/, "")}/api/chat`;
		const headers = BaseAdapter.prepareHeaders(apiKey, "ollama", model.headers);

		return { url, headers, body };
	}

	async processStream(
		responseBody: ReadableStream<Uint8Array>,
		progress: Progress<LanguageModelResponsePart2>,
		token: CancellationToken
	): Promise<StreamResult> {
		try {
			await this.processJsonlStream(responseBody, token, async (trimmed) => {
				try {
					const parsed = JSON.parse(trimmed) as Record<string, unknown>;
					const message = parsed.message as Record<string, unknown> | undefined;
					if (message && typeof message.content === "string" && message.content) {
						const xmlRes = this.processXmlThinkBlocks(message.content, progress);
						if (!xmlRes.emittedAny) {
							this.reportEndThinking(progress);
							this.processTextContent(message.content, progress);
						}
					}
					if (parsed.done === true) {
						let promptTokens: number | undefined;
						let completionTokens: number | undefined;
						if (typeof parsed.prompt_eval_count === "number") {
							promptTokens = parsed.prompt_eval_count;
						}
						if (typeof parsed.eval_count === "number") {
							completionTokens = parsed.eval_count;
						}
						if (promptTokens !== undefined || completionTokens !== undefined) {
							this.emitUsage(progress, {
								promptTokens,
								completionTokens,
								totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0)
							});
						}
					}
				} catch { /* ignore */ }
			});
		} finally {
			this.reportEndThinking(progress);
		}
		return {};
	}
}
