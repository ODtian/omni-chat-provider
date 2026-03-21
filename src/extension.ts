// ──────────────────────────────────────────────────────────────
// Extension entry point
// ──────────────────────────────────────────────────────────────
import * as vscode from "vscode";
import { OmniChatProvider } from "./provider";
import { showPasswordInputBox } from "./utils/helpers";
import { runProviderEditor } from "./services/providerSetup";
import { CommitMessageService } from "./services/commitMessageService";

export function activate(context: vscode.ExtensionContext) {
	console.log("[OmniChat] Extension activating...");

	const provider = new OmniChatProvider(context.secrets);
	const commitMessageService = new CommitMessageService(context.extension.id, context.secrets);
	let disposable: vscode.Disposable;
	const registerProvider = () => {
		disposable?.dispose();
		disposable = vscode.lm.registerLanguageModelChatProvider("omnichat", provider);
		console.log("[OmniChat] Provider registered as 'omnichat'");
	};
	registerProvider();
	context.subscriptions.push({ dispose: () => disposable.dispose() });
	context.subscriptions.push(commitMessageService);

	// ── Config change watcher ──
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (
				e.affectsConfiguration("omnichat.models") ||
				e.affectsConfiguration("omnichat.providers")
			) {
				console.log("[OmniChat] Config changed, re-registering");
				registerProvider();
			}
		})
	);

	// ── Commands ──

	context.subscriptions.push(
		vscode.commands.registerCommand("omnichat.setApiKey", async () => {
			const existing = await context.secrets.get("omnichat.apiKey");
			const apiKey = await showPasswordInputBox({
				title: "OmniChat API Key",
				prompt: existing ? "Update your API key" : "Enter your API key",
				value: existing ?? "",
			});

			if (apiKey === undefined) { return; }
			if (!apiKey.trim()) {
				await context.secrets.delete("omnichat.apiKey");
				vscode.window.showInformationMessage("API key cleared.");
				return;
			}
			await context.secrets.store("omnichat.apiKey", apiKey.trim());
			vscode.window.showInformationMessage("API key saved.");
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("omnichat.editProvider", async () => {
			await runProviderEditor(context.secrets);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("omnichat.setProviderApiKey", async () => {
			await runProviderEditor(context.secrets);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("omnichat.generateCommitMessage", async () => {
			await commitMessageService.generateCommitMessage();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("omnichat.abortCommitMessage", () => {
			commitMessageService.abort();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("omnichat.selectCommitMessageModel", async () => {
			await commitMessageService.selectCommitMessageModel();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("omnichat.editCommitMessagePrompt", async () => {
			await commitMessageService.editCommitMessagePrompt();
		})
	);
}

export function deactivate() {
	// no-op
}
