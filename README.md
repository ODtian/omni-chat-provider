# Omni Chat Provider

A language model chat provider for VS Code's Copilot interface. This extension allows you to use models from multiple providers (OpenAI, Anthropic, Gemini, Ollama, and compatible gateways) directly within the GitHub Copilot Chat interface.

## 🌟 Architecture & Advantages

This is a modern rewrite of the OAI Compatible Copilot provider. It is designed around two key concepts:
1. **Multi-Provider First**: Manage distinct configurations and API keys for different backends.
2. **Native API Adapters**: Connect directly to various AI services using their native payload formats, not just OpenAI completions.

### Supported API Modes

- `openai` — Standard `/v1/chat/completions` API (used by OpenAI and most compatible gateways).
- `openai-responses` — OpenAI's stateful `/v1/responses` API (allows Copilot to thread conversations natively and leverage prompt caching).
- `anthropic` — Anthropic's `/v1/messages` API with native support for `thinking` budgets.
- `gemini` — Google's Gemini `/v1beta/models/{model}:streamGenerateContent` API.
- `ollama` — Local Ollama `/api/chat` interface with native parameter parsing.

## ⚙️ Configuration

Configure providers and models in your VS Code `settings.json`.

### 1. Define Providers

Providers act as templates or "backends". Models inherit `baseUrl`, `apiMode`, and custom `headers` from their provider.

```jsonc
"omnichat.providers": [
    {
        "id": "openai",
        "baseUrl": "https://api.openai.com/v1",
        "apiMode": "openai"
    },
    {
        "id": "anthropic",
        "baseUrl": "https://api.anthropic.com",
        "apiMode": "anthropic"
    },
    {
        "id": "ollama",
        "baseUrl": "http://localhost:11434",
        "apiMode": "ollama"
    }
]
```

### 2. Define Models

Models appear in the VS Code Copilot model picker. You map them back to a provider via `provider` (or `owned_by`).

```jsonc
"omnichat.models": [
    {
        "id": "gpt-4o",
        "provider": "openai",
        "context_length": 128000,
        "max_completion_tokens": 8192,
        "vision": true
    },
    {
        "id": "o1-pro",
        "provider": "openai",
        "reasoning_effort": "xhigh", // OpenAI reasoning effort
        "max_completion_tokens": 65536
    },
    {
        "id": "claude-3-7-sonnet-20250219",
        "provider": "anthropic",
        "thinking": {
            "type": "enabled",
            "budget_tokens": 16384 // Native Anthropic thinking budget
        }
    },
    {
        "id": "llama3",
        "provider": "ollama",
        "num_ctx": 32768, // Native Ollama context window
        "temperature": 0.5
    }
]
```

### 3. Set API Keys

API keys are securely stored in VS Code's Secret Storage, strictly associated with the provider ID.

Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and search:
**OmniChat: Set API Key (Per Provider)**

Select your provider (e.g., `openai`, `anthropic`) and paste your API key.

## 🔧 Model-Specific Parameters

Each API mode accepts its native configuration fields within the `omnichat.models` array. Only parameters relevant to the selected `apiMode` are forwarded to the API.

Instead of translating parameters (e.g., trying to map OpenAI's `max_tokens` to Gemini's `maxOutputTokens`), the extension reads the native parameter directly.

### Common Options
- `context_length`: The max context size to advertise to Copilot.
- `vision` (boolean): Whether this model accepts image input.
- `temperature` / `top_p`: Standard sampling parameters.

### OpenAI (`apiMode: "openai"`)
- `max_completion_tokens`: The maximum number of tokens to generate.
- `reasoning_effort`: Set to `"xhigh"`, `"high"`, `"medium"`, or `"low"`.
- `frequency_penalty`, `presence_penalty`.

### OpenAI Responses (`apiMode: "openai-responses"`)
- `max_output_tokens`: Maximum output tokens.
- `reasoning`: Object containing `effort` and `max_tokens`.

### Anthropic (`apiMode: "anthropic"`)
- `max_tokens`: Maximum tokens to generate.
- `thinking`: Object to enable extended thinking. Example: `{ "type": "enabled", "budget_tokens": 1024 }`
- `top_k`.

### Gemini (`apiMode: "gemini"`)
- `maxOutputTokens`: Maximum tokens to generate.
- `thinkingConfig`: Object to enable thinking. Example: `{ "thinkingBudget": 1024 }`
- `topK`, `topP`.

### Ollama (`apiMode: "ollama"`)
- `num_predict`: Maximum tokens to generate.
- `num_ctx`: Context window size.
- `repeat_penalty`, `seed`, `stop`, etc.

## 🛠 Advanced Features

### Custom Headers
You can supply global or per-provider HTTP headers. This is especially useful for setting API version headers for Anthropic.

```jsonc
"omnichat.providers": [
    {
        "id": "anthropic",
        "baseUrl": "https://api.anthropic.com",
        "apiMode": "anthropic",
        "headers": {
            "anthropic-version": "2023-06-01"
        }
    }
]
```

### Delay Rate Limiting
Prevent rate-limits by adding a minimum delay between consecutive requests to the same model.

```jsonc
"omnichat.models": [
    {
        "id": "gemini-flash",
        "provider": "gemini",
        "delay": 1500 // Wait at least 1500ms between chunks/requests
    }
]
```

### Extra Parameters
Any unsupported fields placed in an `extra` object are shallow-merged directly into the request JSON payload.

## 💡 Note on Copilot Chat Features
This extension registers as a `LanguageModelChatProvider`. To use these models, you must have the **GitHub Copilot Chat** extension installed. You will see these models populated inside the Copilot Chat model picker under the label **Omni Chat Provider**.
