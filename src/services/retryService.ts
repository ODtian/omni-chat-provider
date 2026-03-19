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
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			const isRetryableStatus = retryableCodes.some((code) =>
				lastError?.message.includes(`[${code}]`)
			);
			const isRetryableNetwork = NETWORK_ERROR_PATTERNS.some((pattern) =>
				lastError?.message.includes(pattern)
			);

			if ((!isRetryableStatus && !isRetryableNetwork) || attempt === config.maxAttempts) {
				throw lastError;
			}

			console.error(
				`[OmniChat] Retrying in ${config.intervalMs}ms (attempt ${attempt + 1}/${config.maxAttempts}):`,
				lastError.message
			);
			await new Promise<void>((resolve) => setTimeout(resolve, config.intervalMs));
		}
	}

	throw lastError || new Error("Retry failed");
}
