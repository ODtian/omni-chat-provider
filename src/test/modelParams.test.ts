import test from "node:test";
import assert from "node:assert/strict";

import { getModelInputTokenBudget, getModelMaxOutputTokens } from "../modelParams";
import type { ModelItem } from "../types";

test("getModelMaxOutputTokens resolves per apiMode", () => {
	assert.equal(getModelMaxOutputTokens({ id: "a", owned_by: "p", apiMode: "openai", max_completion_tokens: 123 } as ModelItem), 123);
	assert.equal(getModelMaxOutputTokens({ id: "a", owned_by: "p", apiMode: "openai-responses", max_output_tokens: 456 } as ModelItem), 456);
	assert.equal(getModelMaxOutputTokens({ id: "a", owned_by: "p", apiMode: "anthropic", max_tokens: 789 } as ModelItem), 789);
	assert.equal(getModelMaxOutputTokens({ id: "a", owned_by: "p", apiMode: "gemini", maxOutputTokens: 321 } as ModelItem), 321);
	assert.equal(getModelMaxOutputTokens({ id: "a", owned_by: "p", apiMode: "ollama", num_predict: 654 } as ModelItem), 654);
});

test("getModelInputTokenBudget applies headroom and fallback", () => {
	const model = { id: "a", owned_by: "p", apiMode: "openai", context_length: 10000, max_completion_tokens: 2000 } as ModelItem;
	assert.equal(getModelInputTokenBudget(model, 100), 7900);
	assert.equal(getModelInputTokenBudget({ id: "b", owned_by: "p" } as ModelItem, 100), 123804);
});