import Module from "node:module";

class LanguageModelTextPart {
	constructor(public value: string) {}
}

class LanguageModelDataPart {
	constructor(public data: Uint8Array, public mimeType: string) {}
}

class LanguageModelToolCallPart {
	constructor(
		public callId: string,
		public name: string,
		public input: unknown
	) {}
}

class LanguageModelThinkingPart {
	constructor(
		public value: string | string[],
		public id?: string,
		public metadata?: unknown
	) {}
}

const vscodeMock = {
	LanguageModelTextPart,
	LanguageModelDataPart,
	LanguageModelToolCallPart,
	LanguageModelThinkingPart,
	LanguageModelChatMessageRole: {
		User: 1,
		Assistant: 2,
		System: 3,
	},
};

const moduleWithLoad = Module as typeof Module & {
	_load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = moduleWithLoad._load;

moduleWithLoad._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
	if (request === "vscode") {
		return vscodeMock;
	}

	return originalLoad.call(this, request, parent, isMain);
};