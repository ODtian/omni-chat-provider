// ──────────────────────────────────────────────────────────────
// Retry service
// ──────────────────────────────────────────────────────────────
import type { RetryConfig } from "../types";

const DEFAULT_RETRYABLE_CODES = [429, 500, 502, 503, 504];

const NETWORK_ERROR_PATTERNS = [
	"fetch failed", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND",
	"ECONNREFUSED", "timeout", "TIMEOUT", "network error", "NetworkError",
];

/**
 * Execute an async function with retry logic for transient errors.
 */
export async function executeWithRetry<T>(
	fn: () => Promise<T>,
	config: Required<RetryConfig>
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

			const isRetryableStatus = retryableCodes.some((code) =>
				lastError?.message.includes(`[${code}]`)
			);
			const isRetryableNetwork = NETWORK_ERROR_PATTERNS.some((pattern) =>
				lastError?.message.includes(pattern)
			);
			const isTimeout = lastError?.message.includes("[TIMEOUT]");
			const isEmptyResponse = lastError?.message.includes("[EMPTY_RESPONSE]");

			if (
				(!isRetryableStatus && !isRetryableNetwork && !isTimeout && !isEmptyResponse) ||
				attempt === config.maxAttempts
			) {
				throw lastError;
			}

			console.warn(
				`[OmniChat] Retrying in ${config.intervalMs}ms (attempt ${attempt + 1}/${config.maxAttempts}):`,
				lastError.message
			);
			await new Promise<void>((resolve) => setTimeout(resolve, config.intervalMs));
		}
	}

	throw lastError || new Error("Retry failed");
}
