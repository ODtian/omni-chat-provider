// ──────────────────────────────────────────────────────────────
// Ollama native API adapter (stub — to be filled from old code)
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
import { mapRole } from "../utils/helpers";

export class OllamaAdapter extends BaseAdapter {
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		_modelConfig: { includeReasoningInRequest: boolean }
	): unknown[] {
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
			if (joinedText) {
				out.push({ role, content: joinedText });
			}
		}
		return out;
	}

	buildRequest(
		model: ModelItem,
		baseUrl: string,
		apiKey: string,
		messages: unknown[],
		_options?: ProvideLanguageModelChatResponseOptions
	): PreparedRequest {
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
		const numPredict = (model as any).num_predict;
		if (numPredict !== undefined) { opts.num_predict = numPredict; }
		const numCtx = (model as any).num_ctx;
		if (numCtx !== undefined) { opts.num_ctx = numCtx; }
		const numGpu = (model as any).num_gpu;
		if (numGpu !== undefined) { opts.num_gpu = numGpu; }
		const topK = (model as any).top_k;
		if (topK !== undefined) { opts.top_k = topK; }
		const minP = (model as any).min_p;
		if (minP !== undefined) { opts.min_p = minP; }
		const repeatPenalty = (model as any).repeat_penalty;
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
					const trimmed = line.trim();
					if (!trimmed) { continue; }

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
}
