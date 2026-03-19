// ──────────────────────────────────────────────────────────────
// Extension entry point
// ──────────────────────────────────────────────────────────────
import * as vscode from "vscode";
import { OmniChatProvider } from "./provider";
import { Config } from "./config";

export function activate(context: vscode.ExtensionContext) {
	const provider = new OmniChatProvider(context.secrets);

	// Register the chat provider
	vscode.lm.registerLanguageModelChatProvider("omnichat", provider);

	// ── Commands ──

	// Set global API key
	context.subscriptions.push(
		vscode.commands.registerCommand("omnichat.setApiKey", async () => {
			const existing = await context.secrets.get("omnichat.apiKey");
			const apiKey = await vscode.window.showInputBox({
				title: "OmniChat API Key",
				prompt: existing ? "Update your API key" : "Enter your API key",
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});

			if (apiKey === undefined) {
				return;
			}
			if (!apiKey.trim()) {
				await context.secrets.delete("omnichat.apiKey");
				vscode.window.showInformationMessage("API key cleared.");
				return;
			}
			await context.secrets.store("omnichat.apiKey", apiKey.trim());
			vscode.window.showInformationMessage("API key saved.");
		})
	);

	// Set per-provider API key
	context.subscriptions.push(
		vscode.commands.registerCommand("omnichat.setProviderApiKey", async () => {
			const models = Config.getModels();
			const providers = Array.from(
				new Set(
					models.map((m) => m.owned_by.toLowerCase()).filter((p) => p.trim() !== "")
				)
			).sort();

			if (providers.length === 0) {
				vscode.window.showErrorMessage(
					"No providers found. Configure models in omnichat.models first."
				);
				return;
			}

			const selected = await vscode.window.showQuickPick(providers, {
				title: "Select Provider",
				placeHolder: "Select a provider to configure API key",
			});
			if (!selected) {
				return;
			}

			const providerKey = `omnichat.apiKey.${selected}`;
			const existing = await context.secrets.get(providerKey);

			const apiKey = await vscode.window.showInputBox({
				title: `API Key for ${selected}`,
				prompt: existing ? `Update API key for ${selected}` : `Enter API key for ${selected}`,
				ignoreFocusOut: true,
				password: true,
				value: existing ?? "",
			});

			if (apiKey === undefined) {
				return;
			}
			if (!apiKey.trim()) {
				await context.secrets.delete(providerKey);
				vscode.window.showInformationMessage(`API key for ${selected} cleared.`);
				return;
			}
			await context.secrets.store(providerKey, apiKey.trim());
			vscode.window.showInformationMessage(`API key for ${selected} saved.`);
		})
	);

	// TODO: Git commit message generation commands
	// These will be added when gitCommit module is implemented
}

export function deactivate() {}
