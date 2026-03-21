import { execFile as execFileCallback } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";
import { buildScopedModelId, Config, findConfiguredModelById } from "../config";
import type { ModelItem } from "../types";
import { countTokensForInput } from "./tokenCounter";
import { ApiKeyManager } from "./apiKeyManager";

const execFile = promisify(execFileCallback);
const GENERATING_COMMIT_CONTEXT = "omnichat.isGeneratingCommit";
const MAX_COMMIT_DIFF_CHARS = 30000;
const COMMIT_PROMPT_TOKEN_HEADROOM = 1024;

interface GitExtension {
	getAPI(version: 1): GitApi;
}

interface MaybeThenableGitExtension extends GitExtension, Thenable<GitExtension> {}

interface GitApi {
	repositories: GitRepository[];
}

interface GitRepository {
	rootUri: vscode.Uri;
	inputBox: vscode.SourceControlInputBox;
}

export class CommitMessageService implements vscode.Disposable {
	private _currentRequest?: vscode.CancellationTokenSource;
	private readonly _keyManager: ApiKeyManager;

	constructor(_extensionId: string, secrets?: vscode.SecretStorage) {
		this._keyManager = new ApiKeyManager(secrets ?? {
			get: async () => undefined,
			store: async () => undefined,
			delete: async () => undefined,
			keys: async () => [],
			onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
		});
	}

	dispose(): void {
		this.abort();
	}

	abort(): void {
		this._currentRequest?.cancel();
		this._currentRequest?.dispose();
		this._currentRequest = undefined;
		void vscode.commands.executeCommand("setContext", GENERATING_COMMIT_CONTEXT, false);
	}

	async generateCommitMessage(): Promise<void> {
		if (this._currentRequest) {
			this.abort();
			void vscode.window.showInformationMessage("Commit message generation cancelled.");
			return;
		}

		const repository = await this.pickRepository();
		if (!repository) {
			return;
		}

		const selectedModel = this.resolveCommitModel();
		if (!selectedModel) {
			void vscode.window.showWarningMessage(
				"No commit message model configured. Set `omnichat.commitMessageModel` or mark a model with `useForCommitGeneration`."
			);
			return;
		}

		const scopedModelId = buildScopedModelId(selectedModel);
		const [chatModel] = await vscode.lm.selectChatModels({
			vendor: "omnichat",
			id: scopedModelId,
		});

		if (!chatModel) {
			void vscode.window.showWarningMessage(
				`Configured commit message model \`${scopedModelId}\` is currently unavailable.`
			);
			return;
		}

		const diff = await this.getRepositoryDiff(repository.rootUri.fsPath, selectedModel);
		if (!diff) {
			void vscode.window.showInformationMessage("No staged or unstaged changes found for commit message generation.");
			return;
		}

		const source = new vscode.CancellationTokenSource();
		this._currentRequest = source;
		await vscode.commands.executeCommand("setContext", GENERATING_COMMIT_CONTEXT, true);

		try {
			const result = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: "OmniChat: Generating commit message",
					cancellable: true,
				},
				async (_progress, token) => {
					const requestToken = this.createLinkedToken(token, source.token);
					try {
						return await this.requestCommitMessage(chatModel, diff, selectedModel, requestToken.token);
					} finally {
						requestToken.dispose();
					}
				}
			);

			if (!result?.trim()) {
				throw new Error("Model returned an empty commit message.");
			}

			repository.inputBox.value = result.trim();
			void vscode.window.showInformationMessage("Commit message generated.");
		} catch (error) {
			if (error instanceof vscode.CancellationError) {
				void vscode.window.showInformationMessage("Commit message generation cancelled.");
				return;
			}

			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`Failed to generate commit message: ${message}`);
		} finally {
			this.abort();
		}
	}

	async selectCommitMessageModel(): Promise<void> {
		const models = Config.getModels()
			.filter((model) => !model.id.startsWith("__provider__"))
			.map((model) => {
				const scopedId = buildScopedModelId(model);
				return {
					label: model.displayName || (model.configId ? `${model.id}::${model.configId}` : model.id),
					description: scopedId,
					detail: [
						model.apiMode ?? "openai",
						model.family,
						model.useForCommitGeneration ? "legacy commit flag" : undefined,
					].filter(Boolean).join(" • "),
					model,
				};
			});

		if (models.length === 0) {
			void vscode.window.showWarningMessage("No OmniChat models are configured.");
			return;
		}

		const selected = await vscode.window.showQuickPick(models, {
			title: "Select commit message model",
			placeHolder: "Choose the model used for commit message generation",
			ignoreFocusOut: true,
			matchOnDescription: true,
			matchOnDetail: true,
		});

		if (!selected) {
			return;
		}

		await vscode.workspace.getConfiguration().update(
			"omnichat.commitMessageModel",
			buildScopedModelId(selected.model),
			vscode.ConfigurationTarget.Workspace
		);
		void vscode.window.showInformationMessage(`Commit message model set to ${selected.description}.`);
	}

	async editCommitMessagePrompt(): Promise<void> {
		const current = Config.getCommitMessagePrompt();
		const updated = await vscode.window.showInputBox({
			title: "Edit Commit Message Prompt",
			prompt: "Extra instructions appended when generating commit messages",
			placeHolder: "For example: Use conventional commits and keep subject under 72 characters",
			value: current,
			ignoreFocusOut: true,
		});

		if (updated === undefined) {
			return;
		}

		await vscode.workspace.getConfiguration().update(
			"omnichat.commitMessagePrompt",
			updated,
			vscode.ConfigurationTarget.Workspace
		);
		void vscode.window.showInformationMessage("Commit message prompt updated.");
	}

	private async requestCommitMessage(
		chatModel: vscode.LanguageModelChat,
		diff: { text: string; scopeLabel: string; wasTruncated: boolean },
		model: ModelItem,
		token: vscode.CancellationToken
	): Promise<string> {
		const prompt = this.buildCommitPrompt(diff, model);
		const response = await chatModel.sendRequest(
			[
				new vscode.LanguageModelChatMessage(
					vscode.LanguageModelChatMessageRole.User,
					prompt
				),
			],
			{
				justification: "Generate a git commit message from repository changes",
			},
			token
		);

		let text = "";
		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				text += part.value;
			}
		}
		return text;
	}

	private buildCommitPrompt(
		diff: { text: string; scopeLabel: string; wasTruncated: boolean },
		model: ModelItem
	): string {
		const language = Config.getCommitLanguage();
		const customPrompt = Config.getCommitMessagePrompt().trim();
		const displayName = model.displayName || buildScopedModelId(model);
		const truncationNotice = diff.wasTruncated
			? "Note: the diff was truncated to fit the request budget. Base the message on the available diff only."
			: "";

		return [
			"Generate a concise git commit message for the following changes.",
			`Language: ${language}`,
			"Return only the commit message text. Do not use markdown fences. Do not explain your reasoning.",
			"Prefer one short subject line under 72 characters.",
			"Use imperative mood. Avoid trailing punctuation in the subject line.",
			"Add a blank line and bullet list only if the change is broad enough that a body materially improves clarity.",
			`Selected model: ${displayName}`,
			`Diff scope: ${diff.scopeLabel}`,
			truncationNotice,
			customPrompt ? `Additional instructions:\n${customPrompt}` : "",
			"Git diff:",
			diff.text,
		]
			.filter(Boolean)
			.join("\n\n");
	}

	private resolveCommitModel(): ModelItem | undefined {
		const configured = Config.getCommitMessageModel().trim();
		if (configured) {
			return findConfiguredModelById(configured);
		}

		return Config.getModels().find((model) => model.useForCommitGeneration);
	}

	private async pickRepository(): Promise<GitRepository | undefined> {
		const repositories = this.getGitRepositories();
		if (repositories.length === 0) {
			void vscode.window.showWarningMessage("No Git repository is available.");
			return undefined;
		}

		if (repositories.length === 1) {
			return repositories[0];
		}

		const activeUri = vscode.window.activeTextEditor?.document.uri;
		const matched = activeUri
			? repositories.find((repo) => activeUri.fsPath.startsWith(repo.rootUri.fsPath))
			: undefined;
		if (matched) {
			return matched;
		}

		const picked = await vscode.window.showQuickPick(
			repositories.map((repo) => ({
				label: vscode.workspace.asRelativePath(repo.rootUri, false) || repo.rootUri.fsPath,
				description: repo.rootUri.fsPath,
				repository: repo,
			})),
			{
				title: "Select repository",
				placeHolder: "Choose a repository for commit message generation",
				ignoreFocusOut: true,
			}
		);

		return picked?.repository;
	}

	private getGitRepositories(): GitRepository[] {
		const extension = vscode.extensions.getExtension<MaybeThenableGitExtension>("vscode.git");
		if (!extension?.isActive) {
			return [];
		}
		const git = extension.exports as unknown as GitExtension;
		return git.getAPI(1).repositories ?? [];
	}

	private async getRepositoryDiff(
		root: string,
		model: ModelItem
	): Promise<{ text: string; scopeLabel: string; wasTruncated: boolean } | undefined> {
		const staged = await this.runGit(root, ["diff", "--cached", "--no-ext-diff", "--unified=0", "--submodule=diff"]);
		if (staged.trim()) {
			return await this.limitDiff(staged, "staged changes", model);
		}

		const unstaged = await this.runGit(root, ["diff", "--no-ext-diff", "--unified=0", "--submodule=diff"]);
		if (unstaged.trim()) {
			return await this.limitDiff(unstaged, "working tree changes", model);
		}

		return undefined;
	}

	private async limitDiff(
		text: string,
		scopeLabel: string,
		model: ModelItem
	): Promise<{ text: string; scopeLabel: string; wasTruncated: boolean }> {
		let trimmed = text;
		let wasTruncated = false;

		if (trimmed.length > MAX_COMMIT_DIFF_CHARS) {
			trimmed = `${trimmed.slice(0, MAX_COMMIT_DIFF_CHARS)}\n\n[diff truncated]`;
			wasTruncated = true;
		}

		const maxInputBudget = Math.max(
			2048,
			(model.context_length ?? 128000) - ((model as any).max_completion_tokens ?? (model as any).max_output_tokens ?? (model as any).max_tokens ?? 4096) - COMMIT_PROMPT_TOKEN_HEADROOM
		);

		const tokenSource = new vscode.CancellationTokenSource();
		try {
			while (trimmed.length > 4000) {
				const prompt = this.buildCommitPrompt({ text: trimmed, scopeLabel, wasTruncated }, model);
				const estimated = await countTokensForInput({
					input: prompt,
					keyManager: this._keyManager,
					model,
					token: tokenSource.token,
				});
				if (estimated <= maxInputBudget) {
					break;
				}
				trimmed = `${trimmed.slice(0, Math.max(4000, Math.floor(trimmed.length * 0.8)))}\n\n[diff truncated]`;
				wasTruncated = true;
			}
		} finally {
			tokenSource.dispose();
		}

		return { text: trimmed, scopeLabel, wasTruncated };
	}

	private async runGit(cwd: string, args: string[]): Promise<string> {
		const { stdout } = await execFile("git", args, {
			cwd,
			windowsHide: true,
			maxBuffer: 10 * 1024 * 1024,
		});
		return stdout;
	}

	private createLinkedToken(
		...tokens: vscode.CancellationToken[]
	): vscode.CancellationTokenSource {
		const source = new vscode.CancellationTokenSource();
		const disposables = tokens.map((token) => token.onCancellationRequested(() => source.cancel()));
		const cleanup = source.token.onCancellationRequested(() => {
			for (const disposable of disposables) {
				disposable.dispose();
			}
			cleanup.dispose();
		});
		return source;
	}
}
