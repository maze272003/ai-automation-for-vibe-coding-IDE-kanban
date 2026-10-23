// packages/contracts/src/providers.ts — the provider DTOs the renderer sees. No key material — ever.
import { z } from 'zod';

export type ProviderKindDTO = 'openai_compatible' | 'anthropic' | 'google' | 'ollama';
export type CostClassDTO = 'local' | 'free' | 'free_limited' | 'paid_flat' | 'paid_metered';
export type DataUseDTO = 'no_training' | 'may_train' | 'unknown';

export interface ProviderModelDTO {
  id: string;
  name: string;
  contextLimit: number;
  outputLimit: number;
  inputCost: number | null;
  outputCost: number | null;
}

export interface ProviderDTO {
  id: string;
  label: string;
  kind: ProviderKindDTO;
  /** The AI SDK package OpenCode must use for this provider's protocol. */
  npm: string;
  baseUrl: string;
  connected: boolean;
  /** The provider row's name — different from `id` for a custom endpoint (`custom-<slug>`). */
  connectedId: string | null;
  /** True when the provider is shown first in the picker. */
  featured: boolean;
  costClass: CostClassDTO;
  dataUse: DataUseDTO;
  /** The provider's documentation URL — a display hint. */
  doc: string | null;
  /** The upstream environment variable names, shown as a display hint. */
  env: string[];
  /** Set when the provider cannot be connected with a key alone. */
  unsupportedReason: string | null;
  models: ProviderModelDTO[];
}

export const ConnectProviderSchema = z.object({
  providerId: z.string().min(1).max(100),
  apiKey: z.string().min(1).max(500).optional(),
  baseUrl: z.string().min(1).max(500).optional(),
});

export const SetDefaultModelSchema = z.object({
  providerId: z.string().min(1).max(100),
  modelId: z.string().min(1).max(200),
});

// ── The provider failure marker ─────────────────────────────────────────────────────
// A machine-readable marker for upstream failures: the gateway formats it into the error
// message, and the agents parse it back out to block with the provider's own reason.
export type ProviderFailureReason = 'auth' | 'quota' | 'provider_down' | 'model_limit';

export const PROVIDER_FAILURE_MARKER = '[aik-provider-error]';

/** 401/403 mean the key was rejected, 429 means the quota ran out, everything else (including 0, a transport failure) is the provider being down. */
export function failureReasonForStatus(status: number): ProviderFailureReason {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'quota';
  return 'provider_down';
}

export function formatProviderFailure(f: { status: number; reason: ProviderFailureReason; provider: string; detail: string }): string {
  const detail = f.detail.replace(/\s+/g, ' ').slice(0, 300);
  return `${PROVIDER_FAILURE_MARKER} status=${f.status} reason=${f.reason} provider=${f.provider} detail=${detail}`;
}

export function parseProviderFailure(
  message: string,
): { status: number; reason: ProviderFailureReason; provider: string; detail: string } | null {
  const at = message.indexOf(PROVIDER_FAILURE_MARKER);
  if (at < 0) return null;
  const rest = message.slice(at + PROVIDER_FAILURE_MARKER.length);
  const status = /status=(\d+)/.exec(rest)?.[1];
  const reason = /reason=(auth|quota|provider_down|model_limit)/.exec(rest)?.[1];
  const provider = /provider=([^\s]+)/.exec(rest)?.[1];
  const detail = /detail=(.*)/.exec(rest)?.[1] ?? '';
  if (!status || !reason || !provider) return null;
  return { status: Number(status), reason: reason as ProviderFailureReason, provider, detail };
}
