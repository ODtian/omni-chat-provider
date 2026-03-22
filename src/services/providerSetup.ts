import * as vscode from "vscode";
import type { ApiMode, ProviderItem } from "../types";
import { Config } from "../config";
import { showPasswordInputBox } from "../utils/helpers";

type ProviderDraft = {
	baseUrl: string;
	apiMode: ApiMode;
	apiKey: string;
};

type ScopeItem = vscode.QuickPickItem & { target: vscode.ConfigurationTarget };
type ProviderPickItem = vscode.QuickPickItem & { providerId?: string; isAddNew?: boolean };

const API_MODES: Array<{ label: string; description: string; value: ApiMode }> = [
	{ label: "openai", description: "/chat/completions", value: "openai" },
	{ label: "openai-responses", description: "/responses", value: "openai-responses" },
	{ label: "anthropic", description: "/v1/messages", value: "anthropic" },
	{ label: "gemini", description: "streamGenerateContent", value: "gemini" },
	{ label: "ollama", description: "/api/chat", value: "ollama" },
];

/**
 * QuickPick used to manage OmniChat's own provider definitions and per-provider keys.
 */
export async function runProviderEditor(
	secrets: vscode.SecretStorage
): Promise<void> {
	const sorted = Config.listProviderIds();

	const items: ProviderPickItem[] = sorted.map((id) => ({
		label: `$(cloud) ${id}`,
		description: "Edit provider",
		providerId: id,
	}));

	items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
	items.push({
		label: "$(add) Add provider",
		isAddNew: true,
	});

	const picked = await vscode.window.showQuickPick(items, {
		title: "OmniChat - Edit Provider",
		placeHolder: "Select provider or add new",
	});

	if (!picked) { return; }

	if (picked.isAddNew) {
		await addNewProvider(secrets);
	} else if (picked.providerId) {
		await editProvider(secrets, picked.providerId);
	}
}

async function editProvider(
	secrets: vscode.SecretStorage,
	providerId: string
): Promise<void> {
	const existingProvider = Config.getProviderById(providerId);
	const existingKey = await secrets.get(`omnichat.apiKey.${providerId}`);
	const draft = await promptProviderDraft(
		providerId,
		existingProvider,
		existingKey ?? "",
		"edit"
	);
	if (!draft) { return; }

	if (existingProvider) {
		await updateExistingProvider(providerId, {
			id: providerId,
			baseUrl: draft.baseUrl,
			apiMode: draft.apiMode,
		});
	} else {
		const target = await pickConfigurationTarget();
		if (!target) { return; }
		await appendProvider(
			{
				id: providerId,
				baseUrl: draft.baseUrl,
				apiMode: draft.apiMode,
			},
			target
		);
	}

	await saveProviderKey(secrets, providerId, draft.apiKey, draft.apiMode);
	vscode.window.showInformationMessage(`Provider "${providerId}" updated.`);
}

async function addNewProvider(
	secrets: vscode.SecretStorage
): Promise<void> {
	const id = await vscode.window.showInputBox({
		title: "Provider ID",
		prompt: "e.g. my-relay, deepseek",
		ignoreFocusOut: true,
		validateInput: (value) => {
			const normalized = value.trim().toLowerCase();
			if (!normalized) {
				return "Required";
			}
			if (Config.listProviderIds().includes(normalized)) {
				return "Provider already exists";
			}
			return undefined;
		},
	});
	if (!id) { return; }

	const providerId = id.trim().toLowerCase();
	const draft = await promptProviderDraft(providerId, undefined, "", "add");
	if (!draft) { return; }

	const target = await pickConfigurationTarget();
	if (!target) { return; }

	await appendProvider(
		{
			id: providerId,
			baseUrl: draft.baseUrl,
			apiMode: draft.apiMode,
		},
		target
	);
	await saveProviderKey(secrets, providerId, draft.apiKey, draft.apiMode);

	vscode.window.showInformationMessage(
		`Provider "${providerId}" added. Now attach it in "Chat: Manage Language Models" under OmniChat.`
	);
}

async function promptProviderDraft(
	providerId: string,
	existingProvider: ProviderItem | undefined,
	existingKey: string,
	mode: "add" | "edit"
): Promise<ProviderDraft | undefined> {
	const modePick = await vscode.window.showQuickPick(API_MODES, {
		title: mode === "add" ? "API Mode" : `API Mode - ${providerId}`,
		placeHolder: "Select protocol",
	});
	if (!modePick) { return; }

	const baseUrl = await vscode.window.showInputBox({
		title: mode === "add" ? "Base URL" : `Base URL - ${providerId}`,
		prompt: "e.g. https://api.openai.com/v1",
		ignoreFocusOut: true,
		value: existingProvider?.baseUrl
			?? (modePick.value === "ollama" ? "http://localhost:11434" : ""),
		validateInput: (value) =>
			value.trim().startsWith("http") ? undefined : "Must start with http(s)://",
	});
	if (!baseUrl) { return; }

	const apiKey = await showPasswordInputBox({
		title: `Key - ${providerId}`,
		prompt: modePick.value === "ollama"
			? "Empty = default 'ollama'"
			: existingKey
				? "Update API key"
				: "Enter API key",
		value: existingKey,
	});
	if (apiKey === undefined) { return; }

	return {
		baseUrl: baseUrl.trim(),
		apiMode: modePick.value,
		apiKey: apiKey.trim(),
	};
}

async function saveProviderKey(
	secrets: vscode.SecretStorage,
	providerId: string,
	apiKey: string,
	apiMode: ApiMode
): Promise<void> {
	const storageKey = `omnichat.apiKey.${providerId}`;
	const keyValue = apiKey || (apiMode === "ollama" ? "ollama" : "");
	if (keyValue) {
		await secrets.store(storageKey, keyValue);
	} else {
		await secrets.delete(storageKey);
	}
}

async function pickConfigurationTarget(): Promise<vscode.ConfigurationTarget | undefined> {
	const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
	const scopeItems: ScopeItem[] = [
		{ label: "$(globe) Global", target: vscode.ConfigurationTarget.Global },
	];
	if (hasWorkspace) {
		scopeItems.push({ label: "$(folder) Workspace", target: vscode.ConfigurationTarget.Workspace });
	}

	const scopePick = await vscode.window.showQuickPick(scopeItems, {
		title: "Save to",
		placeHolder: "Where to save this provider?",
	});
	return scopePick?.target;
}

async function appendProvider(
	provider: ProviderItem,
	target: vscode.ConfigurationTarget
): Promise<void> {
	const config = vscode.workspace.getConfiguration("omnichat");
	const existing = config.get<ProviderItem[]>("providers", []);
	await config.update("providers", [...existing, provider], target);
}

async function updateExistingProvider(
	providerId: string,
	updatedProvider: ProviderItem
): Promise<void> {
	const config = vscode.workspace.getConfiguration("omnichat");
	const inspected = config.inspect<ProviderItem[]>("providers");
	const normalized = providerId.trim().toLowerCase();

	const candidates: Array<{
		target: vscode.ConfigurationTarget;
		value: ProviderItem[] | undefined;
	}> = [
		{ target: vscode.ConfigurationTarget.Workspace, value: inspected?.workspaceValue },
		{ target: vscode.ConfigurationTarget.Global, value: inspected?.globalValue },
	];

	for (const candidate of candidates) {
		if (!Array.isArray(candidate.value)) {
			continue;
		}

		const index = candidate.value.findIndex(
			(provider) => provider.id.trim().toLowerCase() === normalized
		);
		if (index < 0) {
			continue;
		}

		const nextProviders = [...candidate.value];
		nextProviders[index] = {
			...nextProviders[index],
			...updatedProvider,
			id: providerId,
		};
		await config.update("providers", nextProviders, candidate.target);
		return;
	}

	const fallbackTarget = await pickConfigurationTarget();
	if (!fallbackTarget) { return; }
	await appendProvider(updatedProvider, fallbackTarget);
}

export async function runProviderSetup(
	secrets: vscode.SecretStorage
): Promise<void> {
	await runProviderEditor(secrets);
}
