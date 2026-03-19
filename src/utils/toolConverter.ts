// ──────────────────────────────────────────────────────────────
// Tool definition converters
// ──────────────────────────────────────────────────────────────
import * as vscode from "vscode";

export interface OpenAIFunctionToolDef {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters?: object;
	};
}

export interface OpenAIResponsesFunctionToolDef {
	type: "function";
	name: string;
	description?: string;
	parameters?: object;
}

/**
 * Convert VS Code tool definitions to OpenAI Chat Completions format.
 */
export function convertToolsToOpenAI(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIFunctionToolDef[];
	tool_choice?: "auto" | { type: "function"; function: { name: string } };
} {
	const tools = options?.tools ?? [];
	if (tools.length === 0) {
		return {};
	}

	const toolDefs: OpenAIFunctionToolDef[] = tools
		.filter((t) => t && typeof t === "object")
		.map((t) => ({
			type: "function" as const,
			function: {
				name: t.name,
				description: typeof t.description === "string" ? t.description : "",
				parameters: t.inputSchema ?? { type: "object", properties: {} },
			},
		}));

	let tool_choice: "auto" | { type: "function"; function: { name: string } } = "auto";
	if (options?.toolMode === vscode.LanguageModelChatToolMode.Required) {
		if (tools.length !== 1) {
			throw new Error("ToolMode.Required is not supported with more than one tool");
		}
		tool_choice = { type: "function", function: { name: tools[0].name } };
	}

	return { tools: toolDefs, tool_choice };
}

/**
 * Convert VS Code tool definitions to OpenAI Responses API format.
 */
export function convertToolsToResponses(options?: vscode.ProvideLanguageModelChatResponseOptions): {
	tools?: OpenAIResponsesFunctionToolDef[];
	tool_choice?: "auto" | { type: "function"; name: string };
} {
	const chatTools = convertToolsToOpenAI(options);
	if (!chatTools.tools?.length) {
		return {};
	}

	const tools: OpenAIResponsesFunctionToolDef[] = chatTools.tools.map((t) => {
		const out: OpenAIResponsesFunctionToolDef = { type: "function", name: t.function.name };
		if (t.function.description) {
			out.description = t.function.description;
		}
		if (t.function.parameters) {
			out.parameters = t.function.parameters;
		}
		return out;
	});

	let tool_choice: "auto" | { type: "function"; name: string } | undefined;
	if (chatTools.tool_choice === "auto") {
		tool_choice = "auto";
	} else if (chatTools.tool_choice?.type === "function") {
		tool_choice = { type: "function", name: chatTools.tool_choice.function.name };
	}

	return { tools, tool_choice };
}
