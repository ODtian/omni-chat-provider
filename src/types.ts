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
	// `thinking`, `maxOutputTokens`, `num_predict`). Adapters should
	// prefer typed sub-interfaces where possible.
	[key: string]: unknown;
}

export interface OpenAIModelItem extends ModelItem {
	max_completion_tokens?: number;
	max_tokens?: number;
	reasoning_effort?: string;
	frequency_penalty?: number;
	presence_penalty?: number;
}

export interface OpenAIResponsesModelItem extends ModelItem {
	max_output_tokens?: number;
	reasoning?: Record<string, unknown>;
}

export interface AnthropicModelItem extends ModelItem {
	max_tokens?: number;
	top_k?: number;
	thinking?: Record<string, unknown>;
}

export interface GeminiModelItem extends ModelItem {
	maxOutputTokens?: number;
	topK?: number;
	topP?: number;
	thinkingConfig?: Record<string, unknown>;
}

export interface OllamaModelItem extends ModelItem {
	num_predict?: number;
	num_ctx?: number;
	num_gpu?: number;
	top_k?: number;
	min_p?: number;
	repeat_penalty?: number;
}

/** Retry configuration. */
export interface RetryConfig {
	enabled?: boolean;
	maxAttempts?: number;
	intervalMs?: number;
	statusCodes?: number[];
	retryRequestErrors?: boolean;
	retryNetworkErrors?: boolean;
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

export interface RetryErrorClassification {
	reason: RetryAttemptInfo["reason"];
	isRetryableStatus: boolean;
	isRetryableNetwork: boolean;
	isTimeout: boolean;
	isEmptyResponse: boolean;
}

/** System prompt interception mode. */
export type SystemPromptMode = "passthrough" | "replace" | "append" | "disable";

/** Parsed model ID (handles the `<providerId>/<id>::<configId>` format). */
export interface ParsedScopedModelId {
	providerId: string;
	baseId: string;
	configId?: string;
}
