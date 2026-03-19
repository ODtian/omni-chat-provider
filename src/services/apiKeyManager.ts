// ──────────────────────────────────────────────────────────────
// API Key Manager — wraps VS Code SecretStorage
// ──────────────────────────────────────────────────────────────
import * as vscode from "vscode";

const KEY_PREFIX = "omnichat.apiKey";

export class ApiKeyManager {
	constructor(private readonly secrets: vscode.SecretStorage) {}

	/** Get the API key for a specific provider, falling back to the global key. */
	async getKey(provider?: string, useGenericFallback = true): Promise<string | undefined> {
		// Try provider-specific key first
		if (provider?.trim()) {
			const normalized = provider.trim().toLowerCase();
			const key = await this.secrets.get(`${KEY_PREFIX}.${normalized}`);
			if (key) {
				return key;
			}
		}

		// Fall back to global key
		if (useGenericFallback) {
			return await this.secrets.get(KEY_PREFIX);
		}
		return undefined;
	}

	/** Store a global API key. */
	async setGlobalKey(key: string): Promise<void> {
		if (key.trim()) {
			await this.secrets.store(KEY_PREFIX, key.trim());
		} else {
			await this.secrets.delete(KEY_PREFIX);
		}
	}

	/** Store a provider-specific API key. */
	async setProviderKey(provider: string, key: string): Promise<void> {
		const normalized = provider.trim().toLowerCase();
		if (key.trim()) {
			await this.secrets.store(`${KEY_PREFIX}.${normalized}`, key.trim());
		} else {
			await this.secrets.delete(`${KEY_PREFIX}.${normalized}`);
		}
	}

	/** Get the API key, prompting the user if not found. */
	async ensureKey(provider?: string, useGenericFallback = true): Promise<string | undefined> {
		let apiKey = await this.getKey(provider, useGenericFallback);
		if (apiKey) {
			return apiKey;
		}

		// Prompt user
		const label = provider ? `API Key for ${provider}` : "API Key";
		const entered = await vscode.window.showInputBox({
			title: `OmniChat ${label}`,
			prompt: `Enter your ${label}`,
			ignoreFocusOut: true,
			password: true,
		});

		if (entered?.trim()) {
			apiKey = entered.trim();
			if (provider && !useGenericFallback) {
				await this.setProviderKey(provider, apiKey);
			} else {
				await this.setGlobalKey(apiKey);
			}
		}
		return apiKey;
	}
}
