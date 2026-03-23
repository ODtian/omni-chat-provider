// ──────────────────────────────────────────────────────────────
// Retry service
// ──────────────────────────────────────────────────────────────
import type { RetryAttemptInfo, RetryConfig, RetryErrorClassification } from "../types";

const DEFAULT_RETRYABLE_CODES = [429, 500, 502, 503, 504];
export const TIMEOUT_MARKER = "[timeout]";
export const EMPTY_RESPONSE_MARKER = "[empty_response]";
export const RETRY_REASON_LABELS: Record<RetryAttemptInfo["reason"], string> = {
	"empty-response": "Empty response",
	network: "Network/stream error",
	"http-status": "Retryable request error",
	timeout: "Request timeout",
	other: "Request error",
};

const NETWORK_ERROR_PATTERNS = [
	"fetch failed",
	"econnreset",
	"etimedout",
	"enotfound",
	"econnrefused",
	"econnaborted",
	"ehostunreach",
	"enetunreach",
	"eai_again",
	"timeout",
	"network error",
	"networkerror",
	"terminated",
	"aborterror",
	"aborted",
	"socket hang up",
	"premature close",
	"other side closed",
];

class RetryClassifiedError extends Error {
	constructor(
		message: string,
		public readonly retryReason: RetryAttemptInfo["reason"]
	) {
		super(message);
		this.name = new.target.name;
	}
}

export class TimeoutRetryError extends RetryClassifiedError {
	constructor(timeoutMs: number) {
		super(`Request timed out after ${timeoutMs}ms`, "timeout");
	}
}

export class EmptyResponseRetryError extends RetryClassifiedError {
	constructor(message = "API stream ended without yielding any content") {
		super(message, "empty-response");
	}
}

export class NetworkRetryError extends RetryClassifiedError {
	constructor(message: string, public readonly causeError?: Error) {
		super(message, "network");
	}
}

export class RetryableHttpError extends RetryClassifiedError {
	constructor(
		public readonly statusCode: number,
		statusText: string,
		details?: string,
		url?: string
	) {
		super(
			`API error: [${statusCode}] ${statusText}${details ? `\n${details}` : ""}${url ? `\nURL: ${url}` : ""}`,
			"http-status"
		);
	}
}

export function classifyRetryError(
	error: Error,
	retryableCodes: readonly number[]
): RetryErrorClassification {
	const normalizedMessage = error.message.toLowerCase();
	const isRetryableStatus = error instanceof RetryableHttpError
		? retryableCodes.includes(error.statusCode)
		: retryableCodes.some((code) => normalizedMessage.includes(`[${code}]`));
	const isRetryableNetwork = NETWORK_ERROR_PATTERNS.some((pattern) =>
		normalizedMessage.includes(pattern)
	);
	const isTimeout = error instanceof TimeoutRetryError || normalizedMessage.includes(TIMEOUT_MARKER);
	const isEmptyResponse = error instanceof EmptyResponseRetryError || normalizedMessage.includes(EMPTY_RESPONSE_MARKER);

	const reason: RetryAttemptInfo["reason"] = error instanceof RetryClassifiedError
		? error.retryReason
		: isTimeout
			? "timeout"
			: isEmptyResponse
				? "empty-response"
				: isRetryableStatus
					? "http-status"
					: isRetryableNetwork
						? "network"
						: "other";

	return {
		reason,
		isRetryableStatus: reason === "http-status",
		isRetryableNetwork: reason === "network",
		isTimeout: reason === "timeout",
		isEmptyResponse: reason === "empty-response",
	};
}

export function createTimeoutError(timeoutMs: number): Error {
	return new TimeoutRetryError(timeoutMs);
}

export function createNetworkRetryError(message: string, causeError?: Error): Error {
	return new NetworkRetryError(message, causeError);
}

export function shouldRetryRequest(options: {
	error: Error;
	tokenCancelled: boolean;
	hasEmittedResponseContent: boolean;
}): boolean | undefined {
	if (options.tokenCancelled) {
		return false;
	}

	if (options.hasEmittedResponseContent) {
		console.warn("[OmniChat] Skip retry because partial content has already been emitted.");
		return false;
	}

	console.warn("[OmniChat] Allow retry because no response content has been emitted yet.");
	return undefined;
}

/**
 * Execute an async function with retry logic for transient errors.
 */
export async function executeWithRetry<T>(
	fn: (signal: AbortSignal) => Promise<T>,
	config: Required<RetryConfig>,
	onRetry?: (info: RetryAttemptInfo) => void | Promise<void>,
	shouldRetry?: (error: Error) => boolean | undefined
): Promise<T> {
	if (!config.enabled) {
		const controller = new AbortController();
		return await fn(controller.signal);
	}

	const retryableCodes = [
		...new Set([...DEFAULT_RETRYABLE_CODES, ...config.statusCodes]),
	];
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= config.maxAttempts; attempt++) {
		const controller = new AbortController();
		let timeoutId: NodeJS.Timeout | undefined;
		const timeoutPromise = config.timeoutMs > 0
			? new Promise<T>((_, reject) => {
					timeoutId = setTimeout(() => {
						controller.abort();
						reject(createTimeoutError(config.timeoutMs));
					}, config.timeoutMs);
			  })
			: null;

		try {
			const result = timeoutPromise
				? await Promise.race([fn(controller.signal), timeoutPromise])
				: await fn(controller.signal);
			if (timeoutId) { clearTimeout(timeoutId); }
			return result;
		} catch (error) {
			if (timeoutId) { clearTimeout(timeoutId); }
			lastError = error instanceof Error ? error : new Error(String(error));
			const classification = classifyRetryError(lastError, retryableCodes);
			const shouldRetryRequestError =
				config.retryRequestErrors && (classification.isRetryableStatus || classification.isTimeout);
			const shouldRetryNetworkError =
				config.retryNetworkErrors && classification.isRetryableNetwork;
			const shouldRetryEmptyResponse =
				config.retryEmptyResponse && classification.isEmptyResponse;
			const defaultRetryable =
				shouldRetryRequestError || shouldRetryNetworkError || shouldRetryEmptyResponse;
			const retryDecision = shouldRetry?.(lastError);
			const canRetry = typeof retryDecision === "boolean"
				? retryDecision
				: defaultRetryable;

			if (
				!canRetry ||
				attempt === config.maxAttempts
			) {
				throw lastError;
			}

			console.warn(
				`[OmniChat] Retrying in ${config.intervalMs}ms (attempt ${attempt + 1}/${config.maxAttempts}):`,
				lastError.message
			);
			const nextRetryAt = new Date(Date.now() + config.intervalMs);
			await onRetry?.({
				attemptNumber: attempt + 1,
				maxAttempts: config.maxAttempts,
				intervalMs: config.intervalMs,
				error: lastError,
				nextRetryAt,
				reason: classification.reason,
			});
			await new Promise<void>((resolve) => setTimeout(resolve, config.intervalMs));
		}
	}

	throw lastError || new Error("Retry failed");
}
