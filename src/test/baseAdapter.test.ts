import test from "node:test";
import assert from "node:assert/strict";

import type { CancellationToken, LanguageModelChatRequestMessage, Progress, ProvideLanguageModelChatResponseOptions } from "vscode";

import { BaseAdapter, type ConvertedMessages, type PreparedRequest, type StreamResult } from "../adapters/base";
import type { ModelItem } from "../types";

class TestAdapter extends BaseAdapter {
	convertMessages(
		_messages: readonly LanguageModelChatRequestMessage[],
		_modelConfig: { includeReasoningInRequest: boolean }
	): ConvertedMessages {
		return { messages: [] };
	}

	buildRequest(
		_model: ModelItem,
		_baseUrl: string,
		_apiKey: string,
		_converted: ConvertedMessages,
		_options?: ProvideLanguageModelChatResponseOptions
	): PreparedRequest {
		return { url: "", headers: {}, body: {} };
	}

	async processStream(
		_body: ReadableStream<Uint8Array>,
		_progress: Progress<any>,
		_token: CancellationToken
	): Promise<StreamResult> {
		return {};
	}

	reportUsage(progress: Progress<any>, usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number }): void {
		this.emitUsage(progress as Progress<any>, usage);
	}
}

test("emitUsage reports VS Code compatible usage payload", () => {
	const adapter = new TestAdapter();
	const reports: unknown[] = [];

	adapter.reportUsage({
		report(value: unknown) {
			reports.push(value);
		},
	}, {
		promptTokens: 120,
		completionTokens: 30,
		totalTokens: 150,
	});

	assert.deepEqual(reports, [{
		kind: "usage",
		promptTokens: 120,
		completionTokens: 30,
	}]);
});