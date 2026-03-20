// ──────────────────────────────────────────────────────────────
// Retry service
// ──────────────────────────────────────────────────────────────
import type { RetryAttemptInfo, RetryConfig } from "../types";

const DEFAULT_RETRYABLE_CODES = [429, 500, 502, 503, 504];

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

/**
 * Execute an async function with retry logic for transient errors.
 */
export async function executeWithRetry<T>(
	fn: () => Promise<T>,
	config: Required<RetryConfig>,
	onRetry?: (info: RetryAttemptInfo) => void | Promise<void>,
	shouldRetry?: (error: Error) => boolean | undefined
): Promise<T> {
	if (!config.enabled) {
		return await fn();
	}

	const retryableCodes = [
		...new Set([...DEFAULT_RETRYABLE_CODES, ...config.statusCodes]),
	];
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= config.maxAttempts; attempt++) {
		let timeoutId: NodeJS.Timeout | undefined;
		const timeoutPromise = config.timeoutMs > 0
			? new Promise<T>((_, reject) => {
					timeoutId = setTimeout(() => reject(new Error(`Request timed out after ${config.timeoutMs}ms [TIMEOUT]`)), config.timeoutMs);
			  })
			: null;

		try {
			const result = timeoutPromise
				? await Promise.race([fn(), timeoutPromise])
				: await fn();
			if (timeoutId) { clearTimeout(timeoutId); }
			return result;
		} catch (error) {
			if (timeoutId) { clearTimeout(timeoutId); }
			lastError = error instanceof Error ? error : new Error(String(error));
			const normalizedMessage = lastError.message.toLowerCase();

			const isRetryableStatus = retryableCodes.some((code) =>
				normalizedMessage.includes(`[${code}]`)
			);
			const isRetryableNetwork = NETWORK_ERROR_PATTERNS.some((pattern) =>
				normalizedMessage.includes(pattern)
			);
			const isTimeout = normalizedMessage.includes("[timeout]");
			const isEmptyResponse = normalizedMessage.includes("[empty_response]");
			const reason: RetryAttemptInfo["reason"] = isTimeout
				? "timeout"
				: isEmptyResponse
					? "empty-response"
					: isRetryableStatus
						? "http-status"
						: isRetryableNetwork
							? "network"
							: "other";
			const shouldRetryRequestError =
				config.retryRequestErrors && (isRetryableStatus || isTimeout);
			const shouldRetryNetworkError =
				config.retryNetworkErrors && isRetryableNetwork;
			const shouldRetryEmptyResponse =
				config.retryEmptyResponse && isEmptyResponse;
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
				reason,
			});
			await new Promise<void>((resolve) => setTimeout(resolve, config.intervalMs));
		}
	}

	throw lastError || new Error("Retry failed");
}
