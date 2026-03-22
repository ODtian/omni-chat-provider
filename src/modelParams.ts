import type {
	AnthropicModelItem,
	ApiMode,
	GeminiModelItem,
	ModelItem,
	OllamaModelItem,
	OpenAIModelItem,
	OpenAIResponsesModelItem,
} from "./types";

export const DEFAULT_CONTEXT_LENGTH = 128000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export function getModelApiMode(model: Pick<ModelItem, "apiMode">): ApiMode {
	return model.apiMode ?? "openai";
}

export function getModelContextLength(model: Pick<ModelItem, "context_length">): number {
	return model.context_length ?? DEFAULT_CONTEXT_LENGTH;
}

export function getModelMaxOutputTokens(model: ModelItem): number | undefined {
	switch (getModelApiMode(model)) {
		case "openai": {
			const openAIModel = model as OpenAIModelItem;
			return openAIModel.max_completion_tokens ?? openAIModel.max_tokens;
		}
		case "openai-responses":
			return (model as OpenAIResponsesModelItem).max_output_tokens;
		case "anthropic":
			return (model as AnthropicModelItem).max_tokens;
		case "gemini":
			return (model as GeminiModelItem).maxOutputTokens;
		case "ollama":
			return (model as OllamaModelItem).num_predict;
		default:
			return undefined;
	}
}

export function getModelInputTokenBudget(model: ModelItem, headroom = 0): number {
	const contextLength = getModelContextLength(model);
	const maxOutputTokens = getModelMaxOutputTokens(model) ?? DEFAULT_MAX_OUTPUT_TOKENS;
	return Math.max(1, contextLength - maxOutputTokens - headroom);
}