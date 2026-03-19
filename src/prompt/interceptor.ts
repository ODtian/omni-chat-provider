// ──────────────────────────────────────────────────────────────
// System prompt interceptor
// ──────────────────────────────────────────────────────────────
import * as vscode from "vscode";
import type { SystemPromptMode } from "../types";
import { mapRole } from "../utils/helpers";

/**
 * Intercept and transform system messages before they are sent to the API.
 *
 * The chatProvider API receives messages from Copilot Chat where:
 * - messages[0] is typically a system message with Copilot's instructions
 * - The rest is conversation history
 *
 * This interceptor modifies / replaces / removes the system message(s)
 * based on user configuration.
 */
export function interceptSystemPrompt(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	mode: SystemPromptMode,
	customContent: string
): vscode.LanguageModelChatRequestMessage[] {
	if (mode === "passthrough") {
		return [...messages];
	}

	const result: vscode.LanguageModelChatRequestMessage[] = [];

	for (const msg of messages) {
		const role = mapRole(msg);

		if (role !== "system") {
			result.push(msg);
			continue;
		}

		switch (mode) {
			case "disable":
				// Drop system messages entirely
				break;

			case "replace":
				if (customContent) {
					// Create a new message with the same structure but replaced text content
					result.push(createSystemMessage(customContent));
				}
				break;

			case "append":
				// Keep original and append custom content
				result.push(msg);
				if (customContent) {
					result.push(createSystemMessage(customContent));
				}
				break;
		}
	}

	return result;
}

function createSystemMessage(text: string): vscode.LanguageModelChatRequestMessage {
	// Create a system message using the VS Code API
	return new vscode.LanguageModelChatMessage(
		vscode.LanguageModelChatMessageRole.User, // Will be mapped to "system" via role detection
		text
	) as unknown as vscode.LanguageModelChatRequestMessage;
}
