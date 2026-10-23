// apps/desktop/src/main/gateway-context.ts — what the main process knows about the model gateway.
// Holds the gateway base URL + per-run gateway token (the only credential OpenCode is allowed to
// know) and the connected provider list as metadata only — never a provider API key. The
// orchestrator-to-restart flow refreshes it so the next lazy OpenCode boot picks up fresh
// providers; the orchestrator API is reached with the existing desktop→orchestrator API token.
import type { OpenCodeProviderSpec } from './opencode-config.ts';

export interface GatewayContext {
  baseUrl: string | null;
  token: string;
  providers: OpenCodeProviderSpec[];
}

interface ProviderListResponse {
  providers: {
    id: string;
    connected: boolean;
    /** The connected row's name — also the virtual provider id (`custom-<slug>` for custom endpoints). */
    connectedId: string | null;
    npm: string;
    models: { id: string; name: string; contextLimit: number; outputLimit: number }[];
  }[];
}

let context: GatewayContext = { baseUrl: null, token: '', providers: [] };

export function setGatewayContext(next: Partial<GatewayContext>): void {
  context = { ...context, ...next };
}

export function getGatewayContext(): GatewayContext {
  return context;
}

/**
 * Reads the connected providers from the orchestrator (GET /providers, API token) and publishes
 * them together with the gateway base URL. No-op when there is no gateway port (personal mode,
 * or a gateway that was never started) — the previous context is left untouched so an OpenCode
 * boot without a gateway still produces the pre-gateway config.
 */
export async function refreshGatewayContext(input: { port: number; apiToken: string; gatewayPort: number | null }): Promise<void> {
  if (input.gatewayPort === null) return;
  try {
    const res = await fetch(`http://127.0.0.1:${input.port}/providers`, {
      headers: { authorization: `Bearer ${input.apiToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return;
    const body = (await res.json()) as ProviderListResponse;
    const connected = body.providers.filter((p) => p.connected && p.connectedId);
    setGatewayContext({
      baseUrl: `http://127.0.0.1:${input.gatewayPort}`,
      // The virtual provider id is the *connected* id (`custom-<slug>` for a custom endpoint).
      providers: connected.map((p) => ({ id: p.connectedId as string, npm: p.npm, models: p.models })),
    });
  } catch {
    // The orchestrator is not reachable — the next model list reports the error.
  }
}
