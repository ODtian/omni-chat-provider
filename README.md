# Omni Chat Provider

Use OpenAI, Anthropic, Gemini, Ollama, and OpenAI-compatible backends inside VS Code Copilot Chat through one extension.

The extension contributes a single vendor, `OmniChat`, to Copilot's language model system. Each model group in `Chat: Manage Language Models` points at one configured `providerId`, so removing a group only removes the Copilot-side mount. Your own `omnichat.providers`, `omnichat.models`, and stored API keys stay intact.

## Features

- Native adapters for `openai`, `openai-responses`, `anthropic`, `gemini`, and `ollama`
- Provider-level connection settings with model-level overrides
- Per-provider API keys stored in VS Code Secret Storage
- Native Copilot model management via `Chat: Manage Language Models`
- Stable internal model routing with clean picker labels
- Retry, delay, custom headers, and system-prompt interception
- Optional model variants via `configId`
- Commit message generation command
- Commit message model selection and prompt editing commands

## How It Works

There are three layers:

1. `omnichat.providers`
   Defines backend connections such as `baseUrl`, `apiMode`, and shared headers.
2. `omnichat.models`
   Defines the actual models shown in Copilot, each mapped to a provider via `provider` or `owned_by`.
3. `Chat: Manage Language Models`
   Creates Copilot model groups that attach one `providerId` to the `OmniChat` vendor.

Deleting a Copilot group does not delete OmniChat settings or OmniChat secrets.

## Requirements

- VS Code `1.104+`
- GitHub Copilot Chat installed

## Setup

### 1. Install the extension

Install the extension from VS Code Marketplace, install the VSIX manually, or install from Open VSX after publishing.

### 2. Define providers

Add provider backends in `settings.json`:

```jsonc
"omnichat.providers": [
  {
    "id": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiMode": "openai"
  },
  {
    "id": "gemini",
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
    "apiMode": "gemini"
  },
  {
    "id": "anthropic",
    "baseUrl": "https://api.anthropic.com",
    "apiMode": "anthropic",
    "headers": {
      "anthropic-version": "2023-06-01"
    }
  },
  {
    "id": "ollama",
    "baseUrl": "http://localhost:11434",
    "apiMode": "ollama"
  }
]
```

### 3. Define models

Each model must point at a provider:

```jsonc
"omnichat.models": [
  {
    "id": "gpt-5.4",
    "provider": "openai",
    "context_length": 128000,
    "max_completion_tokens": 8192,
    "vision": true
  },
  {
    "id": "gpt-5.4",
    "provider": "openai",
    "configId": "reasoning",
    "reasoning_effort": "high",
    "max_completion_tokens": 16384
  },
  {
    "id": "claude-sonnet-4",
    "provider": "anthropic",
    "max_tokens": 8192,
    "thinking": {
      "type": "enabled",
      "budget_tokens": 4096
    }
  },
  {
    "id": "gemini-3-flash-preview",
    "provider": "gemini",
    "maxOutputTokens": 65536,
    "thinkingConfig": {
      "includeThoughts": true
    }
  },
  {
    "id": "llama3.1:70b",
    "provider": "ollama",
    "num_ctx": 32768,
    "temperature": 0.4
  }
]
```

### 4. Add or edit a provider

Run:

`OmniChat: Edit Provider`

This flow lets you:

- Pick an existing provider and edit its `apiMode`, `baseUrl`, and API key
- Add a new provider with the same form

Provider API keys are stored in VS Code Secret Storage under `omnichat.apiKey.<providerId>`.

### 5. Mount the provider into Copilot

Run:

`Chat: Manage Language Models`

Then:

1. Add a new language model group
2. Choose `OmniChat`
3. Enter the `providerId` you want to mount

That group will now expose only the models belonging to that provider.

## Configuration Reference

### `omnichat.providers`

Provider-level backend settings:

- `id`
- `baseUrl`
- `apiMode`
- `headers`

### `omnichat.models`

Model-level settings:

- `id`
- `provider` or `owned_by`
- `configId`
- `displayName`
- `family`
- `context_length`
- `vision`
- `temperature`
- `top_p`
- `headers`
- `delay`
- `extra`
- `useForCommitGeneration`
- `include_reasoning_in_request`

### API-specific model fields

#### OpenAI

- `max_tokens`
- `max_completion_tokens`
- `reasoning_effort`
- `frequency_penalty`
- `presence_penalty`

#### OpenAI Responses

- `max_output_tokens`
- `reasoning`

#### Anthropic

- `max_tokens`
- `thinking`
- `top_k`

#### Gemini

- `maxOutputTokens`
- `topK`
- `topP`
- `thinkingConfig`

#### Ollama

- `num_predict`
- `num_ctx`
- `num_gpu`
- `top_k`
- `min_p`
- `repeat_penalty`

### Retry

```jsonc
"omnichat.retry": {
  "enabled": true,
  "maxAttempts": 3,
  "intervalMs": 1000,
  "statusCodes": [429, 500, 502, 503, 504],
  "retryRequestErrors": true,
  "retryNetworkErrors": true,
  "retryEmptyResponse": true,
  "timeoutMs": 120000
}
```

- `retryRequestErrors`: Retry request errors such as retryable HTTP status codes (`429`, `5xx`) and per-attempt timeouts.
- `retryNetworkErrors`: Retry network or stream interruption errors such as `terminated`, `aborted`, `ECONNRESET`, and `socket hang up`.
- `retryEmptyResponse`: Retry when the request succeeds but the response stream finishes without yielding any content.

### Delay

Global:

```jsonc
"omnichat.delay": 1000
```

Per model:

```jsonc
{
  "id": "gemini-flash",
  "provider": "gemini",
  "delay": 1500
}
```

### System prompt handling

```jsonc
"omnichat.systemPrompt.mode": "passthrough",
"omnichat.systemPrompt.content": ""
```

Modes:

- `passthrough`
- `replace`
- `append`
- `disable`

### Commit message generation

```jsonc
"omnichat.commitLanguage": "English",
"omnichat.commitMessageModel": "openai/gpt-5.4::reasoning",
"omnichat.commitMessagePrompt": ""
```

- `commitLanguage`: 生成 commit message 的语言
- `commitMessageModel`: 指定用于生成 commit message 的模型，格式为 `providerId/modelId` 或 `providerId/modelId::configId`
- `commitMessagePrompt`: 追加的自定义 commit prompt

Commands:

- `OmniChat: Generate Commit Message`
- `OmniChat: Stop Generating Commit Message`
- `OmniChat: Select Commit Message Model`
- `OmniChat: Edit Commit Message Prompt`

The generator prefers staged changes and falls back to unstaged changes when nothing is staged. It will also trim oversized diffs to fit the selected model budget.

## Token counting

`provideTokenCount` now uses a provider-aware strategy:

- `gemini`: native `countTokens` endpoint when available
- `anthropic`: native token count endpoint when available
- `openai` / `openai-responses`: local `tiktoken` estimation with message-structure overhead
- others: improved heuristic fallback for text, thinking parts, tools, and images

## Build

Install dependencies:

```bash
npm install
```

Compile:

```bash
npm run compile
```

Package VSIX:

```bash
npm run package
```

自动 bump 版本：

```bash
pnpm run bump           # patch
pnpm run bump minor
pnpm run bump major
pnpm run bump 0.2.0
pnpm run bump -- --dry-run
```

如果执行前 Git 工作树是干净的，脚本还会自动创建一条 `chore: bump version to x.y.z` 提交，并打上 `vx.y.z` tag。

## GitHub Actions

The repository includes:

- `.github/workflows/marketplace.yml`
- `.github/workflows/openvsx.yml`

Marketplace workflow:

- Build and package `extension.vsix`
- Publish that VSIX to VS Code Marketplace using `MARKETPLACE_TOKEN`

Open VSX workflow:

- Build and package `extension.vsix`
- Publish that VSIX to Open VSX using `OPENVSX_TOKEN`

### Required secrets

Set these repository secrets before publishing:

- `MARKETPLACE_TOKEN`
- `OPENVSX_TOKEN`

If you only use one marketplace, only that secret is required for that workflow.

### Triggering publish

Both publishing workflows run on:

- Manual workflow dispatch
- Git tag pushes matching `v*`

## VS Code Marketplace Publishing

This extension uses the proposed `chatProvider` API, so Marketplace publishing must explicitly allow it.

Local publish:

```bash
npm run package
npm run publish:marketplace -- --pat <MARKETPLACE_TOKEN>
```

This uses:

- `npx @vscode/vsce package`
- `npx @vscode/vsce publish --allow-proposed-apis chatProvider --packagePath extension.vsix`

Before publishing:

1. Create a publisher in Visual Studio Marketplace
2. Make sure `package.json.publisher` matches that publisher exactly
3. Create a PAT for Marketplace publishing
4. Save it as the GitHub secret `MARKETPLACE_TOKEN`

## Open VSX Publishing

Local publish:

```bash
npm run package
npm run publish:openvsx
```

This uses:

- `npx @vscode/vsce package`
- `npx ovsx publish --packagePath extension.vsix`

You still need a valid Open VSX token in your environment as `OVSX_PAT`.