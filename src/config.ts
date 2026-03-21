// ──────────────────────────────────────────────────────────────
// Type-safe configuration access
// ──────────────────────────────────────────────────────────────
import * as vscode from "vscode";
import type {
	ModelItem,
	ParsedScopedModelId,
	ProviderItem,
	RetryConfig,
	SystemPromptMode,
} from "./types";

const SECTION = "omnichat";

/** Centralised, typed access to `omnichat.*` settings. */
export class Config {
	// ── Models ──

	static getProviders(): ProviderItem[] {
		const raw = getMergedArraySetting(`${SECTION}.providers`);
		const providers = raw.filter(
			(item): item is ProviderItem =>
				!!item && typeof item === "object" && typeof (item as any).id === "string"
		);
		const merged = new Map<string, ProviderItem>();
		for (const provider of providers) {
			const normalizedId = normalizeProviderId(provider.id);
			if (!normalizedId) {
				continue;
			}
			merged.set(normalizedId, {
				...provider,
				id: normalizedId,
			});
		}
		return [...merged.values()];
	}

	static getModels(): ModelItem[] {
		const raw = getMergedArraySetting(`${SECTION}.models`);
		const providers = Config.getProviders();
		return normalizeModels(raw, providers);
	}

	static getProviderById(providerId: string): ProviderItem | undefined {
		const normalized = normalizeProviderId(providerId);
		if (!normalized) { return undefined; }
		return Config.getProviders().find((provider) =>
			normalizeProviderId(provider.id) === normalized
		);
	}

	static listProviderIds(): string[] {
		const providerIds = new Set<string>();
		for (const provider of Config.getProviders()) {
			const normalized = normalizeProviderId(provider.id);
			if (normalized) {
				providerIds.add(normalized);
			}
		}
		for (const model of Config.getModels()) {
			const normalized = normalizeProviderId(model.owned_by);
			if (normalized) {
				providerIds.add(normalized);
			}
		}
		return [...providerIds].sort();
	}

	static getModelsForProvider(providerId: string): ModelItem[] {
		const normalized = normalizeProviderId(providerId);
		if (!normalized) { return []; }
		return Config.getModels().filter(
			(model) => normalizeProviderId(model.owned_by) === normalized
		);
	}

	// ── Connection ──

	static getBaseUrl(): string {
		return vscode.workspace
			.getConfiguration()
			.get<string>(`${SECTION}.baseUrl`, "https://api.openai.com/v1");
	}

	// ── Retry ──

	static getRetryConfig(): Required<RetryConfig> {
		const omnichatConfig = vscode.workspace.getConfiguration(SECTION);
		const raw = omnichatConfig.get<RetryConfig>("retry", {});
		return {
			enabled: omnichatConfig.get<boolean>("retry.enabled", raw.enabled ?? true),
			maxAttempts: omnichatConfig.get<number>("retry.maxAttempts", raw.maxAttempts ?? 3),
			intervalMs: omnichatConfig.get<number>("retry.intervalMs", raw.intervalMs ?? 1000),
			statusCodes: omnichatConfig.get<number[]>("retry.statusCodes", raw.statusCodes ?? []),
			retryRequestErrors: omnichatConfig.get<boolean>("retry.retryRequestErrors", raw.retryRequestErrors ?? true),
			retryNetworkErrors: omnichatConfig.get<boolean>("retry.retryNetworkErrors", raw.retryNetworkErrors ?? true),
			retryEmptyResponse: omnichatConfig.get<boolean>("retry.retryEmptyResponse", raw.retryEmptyResponse ?? true),
			timeoutMs: omnichatConfig.get<number>("retry.timeoutMs", raw.timeoutMs ?? 120000),
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

	static getCommitMessageModel(): string {
		return vscode.workspace
			.getConfiguration()
			.get<string>(`${SECTION}.commitMessageModel`, "");
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

function normalizeProviderId(value: string | undefined): string {
	return value?.trim().toLowerCase() ?? "";
}

function getMergedArraySetting(settingKey: string): unknown[] {
	const configuration = vscode.workspace.getConfiguration();
	const inspected = configuration.inspect<unknown>(settingKey);
	if (!inspected) {
		return [];
	}

	const workspaceFolderUri = vscode.workspace.workspaceFolders?.length === 1
		? vscode.workspace.workspaceFolders[0].uri
		: undefined;
	const folderInspection = workspaceFolderUri
		? vscode.workspace.getConfiguration(undefined, workspaceFolderUri).inspect<unknown>(settingKey)
		: undefined;

	const sources = [
		inspected.globalValue,
		inspected.workspaceValue,
		folderInspection?.workspaceFolderValue,
	];

	const merged: unknown[] = [];
	for (const source of sources) {
		if (Array.isArray(source)) {
			merged.push(...source);
		}
	}

	return merged;
}

function normalizeModels(raw: unknown, providers: ProviderItem[]): ModelItem[] {
	const providerMap = new Map<string, ProviderItem>();
	for (const p of providers) {
		providerMap.set(p.id.toLowerCase(), p);
	}

	const list = Array.isArray(raw) ? raw : [];
	const out = new Map<string, ModelItem>();
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

		const dedupeKey = [
			normalizeProviderId(merged.owned_by),
			merged.id.trim(),
			typeof merged.configId === "string" ? merged.configId.trim() : "",
		].join("::");
		out.set(dedupeKey, merged);
	}
	return [...out.values()];
}

function encodeModelSegment(value: string): string {
	return encodeURIComponent(value);
}

function decodeModelSegment(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

export function buildScopedModelId(model: Pick<ModelItem, "owned_by" | "id" | "configId">): string {
	const scopedId = `${encodeModelSegment(model.owned_by)}/${encodeModelSegment(model.id)}`;
	return model.configId
		? `${scopedId}::${encodeModelSegment(model.configId)}`
		: scopedId;
}

/**
 * Parse a model ID in `<providerId>/<id>::<configId>` format.
 */
export function parseScopedModelId(modelId: string): ParsedScopedModelId {
	const configIdx = modelId.indexOf("::");
	const scopedPart = configIdx >= 0 ? modelId.slice(0, configIdx) : modelId;
	const slashIdx = scopedPart.indexOf("/");

	if (slashIdx < 0) {
		return {
			providerId: "",
			baseId: decodeModelSegment(scopedPart),
			configId: configIdx >= 0 ? decodeModelSegment(modelId.slice(configIdx + 2)) : undefined,
		};
	}

	return {
		providerId: decodeModelSegment(scopedPart.slice(0, slashIdx)),
		baseId: decodeModelSegment(scopedPart.slice(slashIdx + 1)),
		configId: configIdx >= 0 ? decodeModelSegment(modelId.slice(configIdx + 2)) : undefined,
	};
}

export function findConfiguredModelById(modelId: string): ModelItem | undefined {
	const trimmed = modelId.trim();
	if (!trimmed) {
		return undefined;
	}

	const parsed = parseScopedModelId(trimmed);
	const models = parsed.providerId
		? Config.getModelsForProvider(parsed.providerId)
		: Config.getModels();

	let found = models.find((model) =>
		model.id === parsed.baseId &&
		((parsed.configId && model.configId === parsed.configId) ||
			(!parsed.configId && !model.configId))
	);

	if (!found) {
		found = models.find((model) => model.id === parsed.baseId);
	}

	if (found) {
		return found;
	}

	return Config.getModels().find((model) => buildScopedModelId(model) === trimmed);
}
