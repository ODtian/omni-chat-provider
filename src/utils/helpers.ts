// ──────────────────────────────────────────────────────────────
// Utility helpers
// ──────────────────────────────────────────────────────────────
import * as vscode from "vscode";

/**
 * Try to parse a JSON object from a string.
 */
export function tryParseJSON(
	text: string
): { ok: true; value: Record<string, unknown> } | { ok: false } {
	try {
		if (!text || !/[{]/.test(text)) {
			return { ok: false };
		}
		const value = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return { ok: true, value };
		}
		return { ok: false };
	} catch {
		return { ok: false };
	}
}

/**
 * Map VS Code message role enum to string.
 */
export function mapRole(
	message: vscode.LanguageModelChatRequestMessage
): "user" | "assistant" | "system" {
	const USER = vscode.LanguageModelChatMessageRole.User as unknown as number;
	const ASSISTANT = vscode.LanguageModelChatMessageRole.Assistant as unknown as number;
	const r = message.role as unknown as number;
	if (r === USER) {
		return "user";
	}
	if (r === ASSISTANT) {
		return "assistant";
	}
	return "system";
}

/**
 * Check if a MIME type is a supported image type.
 */
export function isImageMimeType(mimeType: string): boolean {
	return mimeType.startsWith("image/") &&
		["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType);
}

/**
 * Create a data URL from a LanguageModelDataPart.
 */
export function createDataUrl(dataPart: vscode.LanguageModelDataPart): string {
	const base64Data = Buffer.from(dataPart.data).toString("base64");
	return `data:${dataPart.mimeType};base64,${base64Data}`;
}

/**
 * Type guard for tool result parts.
 */
export function isToolResultPart(
	value: unknown
): value is { callId: string; content?: ReadonlyArray<unknown> } {
	if (!value || typeof value !== "object") {
		return false;
	}
	const obj = value as Record<string, unknown>;
	return typeof obj.callId === "string" && "content" in obj;
}

/**
 * Concatenate tool result content into a single text string.
 */
export function collectToolResultText(
	pr: { content?: ReadonlyArray<unknown> }
): string {
	let text = "";
	for (const c of pr.content ?? []) {
		if (c instanceof vscode.LanguageModelTextPart) {
			text += c.value;
		} else if (typeof c === "string") {
			text += c;
		} else if (c instanceof vscode.LanguageModelDataPart && c.mimeType === "cache_control") {
			/* ignore */
		} else {
			try {
				text += JSON.stringify(c);
			} catch {
				/* ignore */
			}
		}
	}
	return text;
}

/**
 * Show an input box with a toggleable password visibility button.
 */
export function showPasswordInputBox(options: {
	title: string;
	prompt: string;
	value?: string;
}): Promise<string | undefined> {
	return new Promise((resolve) => {
		let resolved = false;
		const input = vscode.window.createInputBox();
		input.title = options.title;
		input.prompt = options.prompt;
		input.value = options.value ?? "";
		input.password = true;
		input.ignoreFocusOut = true;

		const eyeIcon = new vscode.ThemeIcon("eye");
		const eyeClosedIcon = new vscode.ThemeIcon("eye-closed");

		const toggleBtn = {
			iconPath: eyeClosedIcon,
			tooltip: "Show Password"
		};

		input.buttons = [toggleBtn];

		input.onDidTriggerButton((btn) => {
			if (btn === toggleBtn) {
				input.password = !input.password;
				toggleBtn.iconPath = input.password ? eyeClosedIcon : eyeIcon;
				toggleBtn.tooltip = input.password ? "Show Password" : "Hide Password";
				input.buttons = [toggleBtn];
			}
		});

		input.onDidAccept(() => {
			if (!resolved) { resolved = true; resolve(input.value); }
			input.hide();
		});

		input.onDidHide(() => {
			if (!resolved) { resolved = true; resolve(undefined); }
			input.dispose();
		});

		input.show();
	});
}
