import test from "node:test";
import assert from "node:assert/strict";

import { buildGeminiApiUrl } from "../adapters/gemini";

test("buildGeminiApiUrl appends path for plain host baseUrl", () => {
	assert.equal(
		buildGeminiApiUrl("https://generativelanguage.googleapis.com", "gemini-2.5-flash", "streamGenerateContent"),
		"https://generativelanguage.googleapis.com/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
	);
});

test("buildGeminiApiUrl appends model action for v1beta baseUrl", () => {
	assert.equal(
		buildGeminiApiUrl("https://generativelanguage.googleapis.com/v1beta", "gemini-2.5-flash", "countTokens"),
		"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:countTokens"
	);
});

test("buildGeminiApiUrl reuses existing models root and strips models prefix", () => {
	assert.equal(
		buildGeminiApiUrl("https://generativelanguage.googleapis.com/v1beta/models", "models/gemini-2.5-flash", "streamGenerateContent"),
		"https://generativelanguage.googleapis.com/v1beta/models/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
	);
});

test("buildGeminiApiUrl passes apiKey via URL when provided", () => {
	assert.equal(
		buildGeminiApiUrl("https://generativelanguage.googleapis.com", "gemini-2.5-flash", "streamGenerateContent", "some_secret_key"),
		"https://generativelanguage.googleapis.com/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=some_secret_key"
	);
});
