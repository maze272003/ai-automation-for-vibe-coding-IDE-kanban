// packages/providers/src/catalog.overrides.ts
// Hand-verified facts that models.dev does not carry. Every base URL below was read from
// the provider's own API documentation; the comment names the source.
import type { CatalogOverrides } from './types.ts';

export const OVERRIDES: CatalogOverrides = {
  // ── Base URLs for the providers models.dev lists without one (verified 2026-10-22) ───
  baseUrl: {
    // https://platform.openai.com/docs/api-reference
    openai: 'https://api.openai.com/v1',
    // https://docs.anthropic.com/en/api
    anthropic: 'https://api.anthropic.com/v1',
    // https://ai.google.dev/api
    google: 'https://generativelanguage.googleapis.com/v1beta',
    // https://console.groq.com/docs/openai
    groq: 'https://api.groq.com/openai/v1',
    // https://docs.x.ai/docs/api-reference
    xai: 'https://api.x.ai/v1',
    // https://docs.mistral.ai/api
    mistral: 'https://api.mistral.ai/v1',
    // https://docs.together.ai/docs/openai-api-compatibility
    togetherai: 'https://api.together.xyz/v1',
    // https://inference-docs.cerebras.ai/api-reference
    cerebras: 'https://api.cerebras.ai/v1',
    // https://docs.perplexity.ai/api-reference
    perplexity: 'https://api.perplexity.ai',
  },

  // ── Which protocol an AI SDK package speaks ─────────────────────────────────────────
  protocolByNpm: {
    '@ai-sdk/anthropic': 'anthropic',
    '@ai-sdk/google': 'google',
    '@ai-sdk/openai': 'openai',
    '@ai-sdk/openai-compatible': 'openai_compatible',
    '@ai-sdk/groq': 'openai_compatible',
    '@ai-sdk/xai': 'openai_compatible',
    '@ai-sdk/mistral': 'openai_compatible',
    '@ai-sdk/togetherai': 'openai_compatible',
    '@ai-sdk/cerebras': 'openai_compatible',
    '@ai-sdk/perplexity': 'openai_compatible',
    // OpenRouter speaks the OpenAI chat-completions protocol: its SDK posts to
    // https://openrouter.ai/api/v1 with `Authorization: Bearer <key>`
    // (https://openrouter.ai/docs/api-reference/overview).
    '@openrouter/ai-sdk-provider': 'openai_compatible',
  },

  // ── How the gateway injects the upstream credential ──────────────────────────────────
  authByProtocol: {
    anthropic: 'x-api-key',
    google: 'x-goog-api-key',
    openai: 'bearer',
    openai_compatible: 'bearer',
  },

  // ── Providers that need more than an API key ─────────────────────────────────────────
  unsupportedNpm: {
    '@ai-sdk/azure': 'Azure needs a resource name and a deployment path, not just a key',
    '@ai-sdk/amazon-bedrock': 'Bedrock needs AWS credentials and a region',
    '@ai-sdk/google-vertex': 'Vertex AI needs a Google Cloud project',
    '@ai-sdk/google-vertex/anthropic': 'Vertex AI needs a Google Cloud project',
    '@jerome-benoit/sap-ai-provider-v2': 'SAP AI Core needs a tenant and a client id',
    '@ai-sdk/cohere': 'Cohere does not speak the OpenAI chat-completions protocol',
    '@ai-sdk/deepinfra': 'Third-party protocol not verified',
    '@ai-sdk/gateway': 'Third-party protocol not verified',
    '@aihubmix/ai-sdk-provider': 'Third-party protocol not verified',
    '@qvac/ai-sdk-provider': 'Third-party protocol not verified',
    '@saladtechnologies-oss/ai-sdk-provider': 'Third-party protocol not verified',
    'ai-gateway-provider': 'Third-party protocol not verified',
    'gitlab-ai-provider': 'Third-party protocol not verified',
    'merge-gateway-ai-sdk-provider': 'Third-party protocol not verified',
    'venice-ai-sdk-provider': 'Third-party protocol not verified',
    'watsonx-ai-provider': 'Third-party protocol not verified',
  },

  // ── Shown first in the picker (ids verified against the models.dev payload of
  //    2026-10-22; every id here exists in the built catalog) ───────────────────────────
  featured: [
    'openai', 'anthropic', 'google', 'zai', 'zhipuai', 'zai-coding-plan', 'openrouter',
    'groq', 'deepseek', 'mistral', 'xai', 'togetherai', 'moonshotai', 'fireworks-ai',
    'perplexity', 'nvidia', 'cerebras', 'lmstudio', 'ollama', 'custom',
  ],

  // ── Providers that are not in models.dev (local entries shadow a same-named
  //    models.dev entry) ─────────────────────────────────────────────────────────────
  localEntries: {
    // The escape hatch: any OpenAI-compatible service. Its base URL and models are
    // supplied by the user, so it has no base URL and no models of its own.
    custom: {
      label: 'Custom (OpenAI-compatible)',
      npm: '@ai-sdk/openai-compatible',
      baseUrl: '',
      auth: 'bearer',
      doc: null,
      models: [],
    },
    // https://github.com/ollama/ollama/blob/main/docs/api.md
    ollama: {
      label: 'Ollama (local)',
      npm: '@ai-sdk/openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      auth: 'none',
      doc: 'https://github.com/ollama/ollama/blob/main/docs/api.md',
      models: [
        { id: 'qwen3-coder', name: 'Qwen3 Coder', contextLimit: 262144, outputLimit: 32768, inputCost: null, outputCost: null, toolCall: true, reasoning: true },
        { id: 'llama3.3', name: 'Llama 3.3', contextLimit: 131072, outputLimit: 32768, inputCost: null, outputCost: null, toolCall: true, reasoning: false },
      ],
    },
    // https://lmstudio.ai/docs — models.dev also lists lmstudio, but the local entry
    // takes over (see buildCatalog) because a local server must not ask for a key.
    // LM Studio's real model ids depend on which model the user loaded, so a
    // downstream task discovers the live list from the endpoint's /models route.
    lmstudio: {
      label: 'LM Studio (local)',
      npm: '@ai-sdk/openai-compatible',
      baseUrl: 'http://127.0.0.1:1234/v1',
      auth: 'none',
      doc: 'https://lmstudio.ai/docs',
      models: [
        { id: 'local-model', name: 'Local model', contextLimit: 131072, outputLimit: 8192, inputCost: null, outputCost: null, toolCall: true, reasoning: false },
      ],
    },
  },
};
