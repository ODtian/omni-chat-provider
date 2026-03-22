import test from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";

import { normalizeChatMessage } from "../utils/helpers";

test("normalizeChatMessage extracts text images tools and thinking", () => {
	const message = {
		role: vscode.LanguageModelChatMessageRole.User,
		content: [
			new vscode.LanguageModelTextPart("hello "),
			new vscode.LanguageModelTextPart("world"),
			new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), "image/png"),
			new vscode.LanguageModelToolCallPart("call-1", "read_file", { filePath: "a.ts" }),
			{ callId: "call-1", content: [new vscode.LanguageModelTextPart("tool output")] },
			new vscode.LanguageModelThinkingPart("deep thought", "thinking-1", { thoughtSignature: "sig-1" }),
		],
	};

	const normalized = normalizeChatMessage(message as never, { includeReasoningInRequest: true });

	assert.equal(normalized.role, "user");
	assert.equal(normalized.joinedText, "hello world");
	assert.equal(normalized.imageParts.length, 1);
	assert.deepEqual(normalized.toolCalls[0], {
		id: "call-1",
		name: "read_file",
		arguments: JSON.stringify({ filePath: "a.ts" }),
	});
	assert.deepEqual(normalized.toolResults[0], {
		callId: "call-1",
		content: "tool output",
	});
	assert.equal(normalized.joinedThinking, "deep thought");
	assert.equal(normalized.thinkingParts[0]?.metadata?.thoughtSignature, "sig-1");
});

test("normalizeChatMessage ignores retry notices and disabled thinking capture", () => {
	const message = {
		role: vscode.LanguageModelChatMessageRole.Assistant,
		content: [
			new vscode.LanguageModelTextPart("answer"),
			new vscode.LanguageModelThinkingPart("skip me", "thinking-1", { type: "retry_notice" }),
			new vscode.LanguageModelThinkingPart("keep me", "thinking-2"),
		],
	};

	const withThinking = normalizeChatMessage(message as never, { includeReasoningInRequest: true });
	assert.equal(withThinking.joinedThinking, "keep me");

	const withoutThinking = normalizeChatMessage(message as never, { includeReasoningInRequest: false });
	assert.equal(withoutThinking.joinedThinking, "");
	assert.equal(withoutThinking.thinkingParts.length, 0);
});