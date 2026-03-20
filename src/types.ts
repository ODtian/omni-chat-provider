// ──────────────────────────────────────────────────────────────
// Types for Omni Chat Provider
// ──────────────────────────────────────────────────────────────

/** Supported API modes. */
export type ApiMode = "openai" | "openai-responses" | "ollama" | "anthropic" | "gemini";

/**
 * A provider definition as configured by the user in `omnichat.providers`.
 * Providers define connection-level settings shared by multiple models.
 */
export interface ProviderItem {
	id: string;
	baseUrl?: string;
	apiMode?: ApiMode;
	headers?: Record<string, string>;
}

/**
 * A model entry as configured by the user in `omnichat.models`.
 *
 * Common fields live at the top level; API-specific parameters
 * are stored as-is and each adapter reads what it needs.
 */
export interface ModelItem {
	// ── Identity ──
	id: string;
	owned_by: string;
	configId?: string;
	displayName?: string;
	family?: string;

	// ── Connection ──
	apiMode?: ApiMode;
	baseUrl?: string;
	headers?: Record<string, string>;

	// ── Common parameters ──
	context_length?: number;
	vision?: boolean;
	temperature?: number | null;
	top_p?: number | null;
	delay?: number;

	// ── Feature flags ──
	useForCommitGeneration?: boolean;
	include_reasoning_in_request?: boolean;

	/**
	 * Extra request body parameters passed directly to the API.
	 * Useful for provider-specific settings not covered by typed fields.
	 */
	extra?: Record<string, unknown>;

	// ── API-native parameters (pass-through) ──
	// The model config object may contain any additional properties
	// that are specific to the selected apiMode (e.g. `max_tokens`,
	// `thinking`, `maxOutputTokens`, `num_predict`). Adapters read
	// these directly via `(model as any).fieldName`.
	[key: string]: unknown;
}

/** Retry configuration. */
export interface RetryConfig {
	enabled?: boolean;
	maxAttempts?: number;
	intervalMs?: number;
	statusCodes?: number[];
	retryEmptyResponse?: boolean;
	timeoutMs?: number;
}

export interface RetryAttemptInfo {
	attemptNumber: number;
	maxAttempts: number;
	intervalMs: number;
	error: Error;
	nextRetryAt: Date;
	reason: "timeout" | "empty-response" | "http-status" | "network" | "other";
}

/** System prompt interception mode. */
export type SystemPromptMode = "passthrough" | "replace" | "append" | "disable";

/** Parsed model ID (handles the `<providerId>/<id>::<configId>` format). */
export interface ParsedScopedModelId {
	providerId: string;
	baseId: string;
	configId?: string;
}
