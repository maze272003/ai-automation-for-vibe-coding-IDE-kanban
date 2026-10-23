// apps/desktop/src/main/opencode-config.ts — the virtual providers the isolated OpenCode server
// sees (spec PK-4.5). Pure builder: one virtual provider per connected upstream provider, each
// keeping its own AI SDK package so OpenCode speaks that provider's native protocol, and all of
// them pointing at the loopback gateway with the gateway token — never a provider API key.
export interface OpenCodeModelSpec {
  id: string;
  name: string;
  contextLimit: number;
  outputLimit: number;
}

export interface OpenCodeProviderSpec {
  id: string;
  npm: string;
  models: OpenCodeModelSpec[];
}

export interface OpenCodeProviderConfig {
  npm: string;
  options: { baseURL: string; apiKey: string; headers: Record<string, string> };
  models: Record<string, { name: string; limit: { context: number; output: number } }>;
}

/**
 * One virtual provider per connected upstream provider. The `apiKey` OpenCode is allowed to
 * know is the per-run gateway token; the real provider key stays in the orchestrator's vault
 * and is injected by the gateway at the last moment.
 */
export function buildProviderConfig(input: {
  providers: OpenCodeProviderSpec[];
  gatewayBaseUrl: string;
  gatewayToken: string;
}): Record<string, OpenCodeProviderConfig> {
  const out: Record<string, OpenCodeProviderConfig> = {};
  // Deterministic key order (the plan's config test locks it) — stable output across refreshes.
  const providers = [...input.providers].sort((a, b) => a.id.localeCompare(b.id));
  for (const provider of providers) {
    const models: Record<string, { name: string; limit: { context: number; output: number } }> = {};
    for (const model of provider.models) {
      models[model.id] = { name: model.name, limit: { context: model.contextLimit, output: model.outputLimit } };
    }
    out[provider.id] = {
      npm: provider.npm,
      options: {
        baseURL: input.gatewayBaseUrl,
        apiKey: input.gatewayToken,
        headers: { 'x-aik-provider': provider.id },
      },
      models,
    };
  }
  return out;
}
