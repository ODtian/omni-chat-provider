// ──────────────────────────────────────────────────────────────
// Type-safe configuration access
// ──────────────────────────────────────────────────────────────
import * as vscode from "vscode";
import type { ModelItem, ProviderItem, RetryConfig, SystemPromptMode } from "./types";

const SECTION = "omnichat";

/** Centralised, typed access to `omnichat.*` settings. */
export class Config {
	// ── Models ──

	static getProviders(): ProviderItem[] {
		const raw = vscode.workspace.getConfiguration().get<unknown>(
			`${SECTION}.providers`,
			[]
		);
		const list = Array.isArray(raw) ? raw : [];
		return list.filter(
			(p): p is ProviderItem =>
				!!p && typeof p === "object" && typeof (p as any).id === "string"
		);
	}

	static getModels(): ModelItem[] {
		const raw = vscode.workspace.getConfiguration().get<unknown>(
			`${SECTION}.models`,
			[]
		);
		const providers = Config.getProviders();
		return normalizeModels(raw, providers);
	}

	// ── Connection ──

	static getBaseUrl(): string {
		return vscode.workspace
			.getConfiguration()
			.get<string>(`${SECTION}.baseUrl`, "https://api.openai.com/v1");
	}

	// ── Retry ──

	static getRetryConfig(): Required<RetryConfig> {
		const raw = vscode.workspace
			.getConfiguration()
			.get<RetryConfig>(`${SECTION}.retry`, {});
		return {
			enabled: raw.enabled ?? true,
			maxAttempts: raw.maxAttempts ?? 3,
			intervalMs: raw.intervalMs ?? 1000,
			statusCodes: raw.statusCodes ?? [],
		};
	}

	// ── Delay ──

	static getGlobalDelay(): number {
		return vscode.workspace
			.getConfiguration()
			.get<number>(`${SECTION}.delay`, 0);
	}

	static getDelay(model?: ModelItem): number {
		return model?.delay ?? Config.getGlobalDelay();
	}

	// ── System Prompt ──

	static getSystemPromptMode(): SystemPromptMode {
		return vscode.workspace
			.getConfiguration()
			.get<SystemPromptMode>(`${SECTION}.systemPrompt.mode`, "passthrough");
	}

	static getSystemPromptContent(): string {
		return vscode.workspace
			.getConfiguration()
			.get<string>(`${SECTION}.systemPrompt.content`, "");
	}

	// ── Misc ──

	static getReadFileLines(): number {
		return vscode.workspace
			.getConfiguration()
			.get<number>(`${SECTION}.readFileLines`, 0);
	}

	static getCommitLanguage(): string {
		return vscode.workspace
			.getConfiguration()
			.get<string>(`${SECTION}.commitLanguage`, "English");
	}

	static getCommitMessagePrompt(): string {
		return vscode.workspace
			.getConfiguration()
			.get<string>(`${SECTION}.commitMessagePrompt`, "");
	}
}

// ── Helpers ──

function getProviderId(obj: Record<string, unknown>): string {
	const pick = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
	return (
		pick(obj.owned_by) ||
		pick(obj.provider) ||
		pick(obj.provide) ||
		pick(obj.vendor) ||
		""
	);
}

function normalizeModels(raw: unknown, providers: ProviderItem[]): ModelItem[] {
	const providerMap = new Map<string, ProviderItem>();
	for (const p of providers) {
		providerMap.set(p.id.toLowerCase(), p);
	}

	const list = Array.isArray(raw) ? raw : [];
	const out: ModelItem[] = [];
	for (const item of list) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const obj = item as Record<string, unknown>;
		const providerId = getProviderId(obj);
		const providerDef = providerId ? providerMap.get(providerId.toLowerCase()) : undefined;

		// Model fields override provider fields which override globals
		const merged: ModelItem = {
			...(obj as ModelItem),
			owned_by: providerId,
		};

		if (providerDef) {
			// Inherit baseUrl from provider if not set on model
			if (!merged.baseUrl && providerDef.baseUrl) {
				merged.baseUrl = providerDef.baseUrl;
			}
			// Inherit apiMode from provider if not set on model
			if (!merged.apiMode && providerDef.apiMode) {
				merged.apiMode = providerDef.apiMode;
			}
			// Merge headers: provider headers as base, model headers override
			if (providerDef.headers) {
				merged.headers = { ...providerDef.headers, ...merged.headers };
			}
		}

		out.push(merged);
	}
	return out;
}

/**
 * Parse a model ID that may contain `::configId`.
 */
export function parseModelId(modelId: string): { baseId: string; configId?: string } {
	const idx = modelId.indexOf("::");
	if (idx >= 0) {
		return { baseId: modelId.slice(0, idx), configId: modelId.slice(idx + 2) };
	}
	return { baseId: modelId };
}
