import test from "node:test";
import assert from "node:assert/strict";

import {
	classifyRetryError,
	createNetworkRetryError,
	createTimeoutError,
	EmptyResponseRetryError,
	RetryableHttpError,
	shouldRetryRequest,
} from "../services/retryService";

test("classifyRetryError prefers structured error types", () => {
	assert.equal(classifyRetryError(createTimeoutError(1000), [429]).reason, "timeout");
	assert.equal(classifyRetryError(new EmptyResponseRetryError(), [429]).reason, "empty-response");
	assert.equal(classifyRetryError(new RetryableHttpError(429, "Too Many Requests"), [429]).reason, "http-status");
	assert.equal(classifyRetryError(createNetworkRetryError("socket hang up"), [429]).reason, "network");
});

test("shouldRetryRequest blocks cancelled or partially emitted responses", () => {
	assert.equal(shouldRetryRequest({ error: new Error("x"), tokenCancelled: true, hasEmittedResponseContent: false }), false);
	assert.equal(shouldRetryRequest({ error: new Error("x"), tokenCancelled: false, hasEmittedResponseContent: true }), false);
	assert.equal(shouldRetryRequest({ error: new Error("x"), tokenCancelled: false, hasEmittedResponseContent: false }), undefined);
});