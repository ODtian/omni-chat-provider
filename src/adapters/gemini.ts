// ──────────────────────────────────────────────────────────────
// Gemini native API adapter (stub — to be filled from old code)
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

export class GeminiAdapter extends BaseAdapter {
	convertMessages(
		messages: readonly LanguageModelChatRequestMessage[],
		_modelConfig: { includeReasoningInRequest: boolean }
	): unknown[] {
		const systemParts: string[] = [];
		const contents: unknown[] = [];

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
				systemParts.push(joinedText);
				continue;
			}

			if (joinedText) {
				const geminiRole = role === "assistant" ? "model" : "user";
				contents.push({
					role: geminiRole,
					parts: [{ text: joinedText }],
				});
			}
		}

		// Store system content for use in buildRequest
		if (systemParts.length > 0) {
			this._systemContent = systemParts.join("\n");
		}

		return contents;
	}

	buildRequest(
		model: ModelItem,
		baseUrl: string,
		apiKey: string,
		messages: unknown[],
		_options?: ProvideLanguageModelChatResponseOptions
	): PreparedRequest {
		const body: Record<string, unknown> = {
			contents: messages,
		};

		if (this._systemContent) {
			body.systemInstruction = {
				role: "user",
				parts: [{ text: this._systemContent }],
			};
		}

		// Generation config with Gemini-native parameter names
		const genConfig: Record<string, unknown> = {};
		if (model.temperature !== undefined && model.temperature !== null) {
			genConfig.temperature = model.temperature;
		}
		if (model.top_p !== undefined && model.top_p !== null) {
			genConfig.topP = model.top_p;
		}
		const maxOutput = (model as any).maxOutputTokens;
		if (maxOutput !== undefined) { genConfig.maxOutputTokens = maxOutput; }
		const topK = (model as any).topK;
		if (topK !== undefined) { genConfig.topK = topK; }
		const topP = (model as any).topP;
		if (topP !== undefined) { genConfig.topP = topP; }

		if (Object.keys(genConfig).length > 0) {
			body.generationConfig = genConfig;
		}

		// Thinking config
		const thinkingConfig = (model as any).thinkingConfig;
		if (thinkingConfig && typeof thinkingConfig === "object") {
			body.thinkingConfig = thinkingConfig;
		}

		// Extra
		if (model.extra) {
			for (const [key, value] of Object.entries(model.extra)) {
				if (value !== undefined) { body[key] = value; }
			}
		}

		// Build Gemini URL
		const normalized = baseUrl.replace(/\/+$/, "");
		const url = `${normalized}/v1beta/models/${model.id}:streamGenerateContent?alt=sse`;
		const headers = BaseAdapter.prepareHeaders(apiKey, "gemini", model.headers);

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
					if (!data || data === "[DONE]") { continue; }

					try {
						const parsed = JSON.parse(data) as Record<string, unknown>;
						this.processGeminiChunk(parsed, progress);
					} catch { /* ignore */ }
				}
			}
		} finally {
			reader.releaseLock();
			this.reportEndThinking(progress);
		}
		return {};
	}

	private processGeminiChunk(
		chunk: Record<string, unknown>,
		progress: Progress<LanguageModelResponsePart2>
	): void {
		const candidates = chunk.candidates as Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(candidates) || candidates.length === 0) { return; }

		const content = candidates[0].content as Record<string, unknown> | undefined;
		if (!content) { return; }

		const parts = content.parts as Array<Record<string, unknown>> | undefined;
		if (!Array.isArray(parts)) { return; }

		for (const part of parts) {
			if (typeof part.text === "string" && part.text) {
				this.reportEndThinking(progress);
				const res = this.processTextContent(part.text, progress);
				if (res.emittedAny) { this._hasEmittedAssistantText = true; }
			} else if (typeof part.thought === "string" && part.thought) {
				this.bufferThinkingContent(part.thought, progress);
			}
		}
	}
}
