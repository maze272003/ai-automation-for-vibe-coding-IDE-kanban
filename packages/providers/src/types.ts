// packages/providers/src/types.ts — the shape of a provider the app can connect.
export type AuthFlavour = 'none' | 'bearer' | 'x-api-key' | 'x-goog-api-key' | 'api-key';
export type ProviderProtocol = 'anthropic' | 'google' | 'openai' | 'openai_compatible';
export type CostClass = 'local' | 'free' | 'free_limited' | 'paid_flat' | 'paid_metered';
export type DataUse = 'no_training' | 'may_train' | 'unknown';

export interface CatalogModel {
  id: string;
  name: string;
  contextLimit: number;
  outputLimit: number;
  inputCost: number | null;
  outputCost: number | null;
  toolCall: boolean;
  reasoning: boolean;
}

export interface CatalogProvider {
  id: string;
  label: string;
  protocol: ProviderProtocol;
  npm: string;
  baseUrl: string;
  auth: AuthFlavour;
  env: string[];
  doc: string | null;
  costClass: CostClass;
  dataUse: DataUse;
  featured: boolean;
  /** Set when the provider needs more than an API key; the UI disables it and shows the reason. */
  unsupportedReason: string | null;
  models: CatalogModel[];
}

export interface CatalogOverrides {
  /** Base URL for providers models.dev lists without one, keyed by provider id. */
  baseUrl: Record<string, string>;
  /** Which protocol an AI SDK package speaks, keyed by npm package name. */
  protocolByNpm: Record<string, ProviderProtocol>;
  /** How the gateway injects the upstream credential, keyed by protocol. */
  authByProtocol: Record<ProviderProtocol, AuthFlavour>;
  /** Packages that need more than an API key, with the reason. */
  unsupportedNpm: Record<string, string>;
  /** Provider ids shown first in the picker. */
  featured: string[];
  /** Providers that are not in models.dev at all, keyed by provider id. */
  localEntries: Record<string, LocalProviderEntry>;
}

export interface LocalProviderEntry {
  label: string;
  npm: string;
  baseUrl: string;
  auth: AuthFlavour;
  doc: string | null;
  models: CatalogModel[];
}
