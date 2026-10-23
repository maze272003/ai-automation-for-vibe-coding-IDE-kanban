// apps/orchestrator/src/providers/service.ts — which providers are connected, and which models they offer.
// Corrections applied beyond the plan (parallel dispatch, 2026-10-23):
// 1. The base-URL guard covers every preset, not only custom endpoints, and rejects `$`
//    placeholders anywhere in the URL — models.dev carries five provider-level base URLs that
//    are `$`-env templates (neon, cloudflare-workers-ai, databricks, infomaniak,
//    snowflake-cortex); connecting one would build a broken gateway config. A custom
//    endpoint keeps the plan's own checks on the user-supplied URL.
// 2. Local providers (`auth: 'none'`, i.e. ollama and lmstudio) discover their models from
//    the live endpoint like custom endpoints do, falling back to the catalog's
//    representative models when the endpoint does not answer.
// 3. The plan's `getConnected` called a nonexistent `this.catalog()`; it reads `CATALOG`.
// 4. `connect` returns the row-scoped DTO for a custom endpoint instead of searching
//    `list()`: that list aggregates every custom endpoint under one entry carrying the
//    FIRST endpoint's id, so the plan's own second-connect test could never find its DTO.
import { CATALOG, type AuthFlavour, type CatalogProvider } from '@aik/providers';
import { appSettings, modelProfiles, providers, type AikDb } from '@aik/db';
import { eq } from 'drizzle-orm';
import type { ProviderDTO, ProviderModelDTO } from '@aik/contracts';
import type { ProviderVault } from './vault.ts';

export type ProviderKind = 'openai_compatible' | 'anthropic' | 'google' | 'ollama';

export interface ConnectedProvider {
  id: string;
  kind: ProviderKind;
  npm: string;
  baseUrl: string;
  auth: AuthFlavour;
  modelIds: string[];
}

export interface ProviderServiceDeps {
  db: AikDb;
  vault: ProviderVault;
  now: () => number;
  /** Discovers the model ids of a custom or local OpenAI-compatible endpoint. */
  discoverModels?: (baseUrl: string, key: string) => Promise<string[]>;
}

const DEFAULT_MODEL_KEY = 'default_model';
// Discovered endpoints report only ids, so their rows use these documented limits.
const DISCOVERED_CONTEXT_LIMIT = 128_000;
const DISCOVERED_OUTPUT_LIMIT = 8_192;

function toDiscoveredModel(modelId: string): { modelId: string; name: string; contextLimit: number; outputLimit: number } {
  return { modelId, name: modelId, contextLimit: DISCOVERED_CONTEXT_LIMIT, outputLimit: DISCOVERED_OUTPUT_LIMIT };
}

function kindOf(provider: CatalogProvider): ProviderKind {
  if (provider.auth === 'none') return 'ollama';
  if (provider.protocol === 'anthropic') return 'anthropic';
  if (provider.protocol === 'google') return 'google';
  return 'openai_compatible';
}

/** `http://127.0.0.1:1234/v1` -> host; used to give each custom endpoint a readable id. */
function slugOf(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
    return host || 'endpoint';
  } catch {
    return 'endpoint';
  }
}

/** Reads the model ids of an OpenAI-compatible endpoint. Returns [] when the route is absent. */
export async function discoverModelsFromEndpoint(baseUrl: string, key: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { id?: string }[] };
    return (body.data ?? []).map((m) => m.id ?? '').filter((id) => id.length > 0);
  } catch {
    return [];
  }
}

export class ProviderService {
  constructor(private readonly deps: ProviderServiceDeps) {}

  /** The underlying database — the provider routes need it for the idempotency helper. */
  get db(): AikDb {
    return this.deps.db;
  }

  /** Every catalog provider, with `connected` set and the models of the connected ones. */
  list(): ProviderDTO[] {
    const rows = this.connectedRows();
    const byPreset = new Map<string, string[]>();
    for (const row of rows.values()) {
      const presetKey = row.presetKey ?? '';
      byPreset.set(presetKey, [...(byPreset.get(presetKey) ?? []), row.name]);
    }
    return CATALOG.map((p) => {
      // A catalog provider is connected when a row with its name exists. The `custom`
      // preset holds any number of endpoints, so it matches on the preset key instead.
      const matched = p.id === 'custom'
        ? (byPreset.get(p.id) ?? []).map((name) => rows.get(name)!).filter(Boolean)
        : rows.has(p.id) ? [rows.get(p.id)!] : [];
      const models: ProviderModelDTO[] = [];
      for (const row of matched) {
        for (const m of this.modelsOf(row.id)) {
          models.push({
            id: m.modelId,
            name: m.family ?? m.modelId,
            contextLimit: m.contextLimit,
            outputLimit: m.outputLimit,
            inputCost: null,
            outputCost: null,
          });
        }
      }
      return {
        id: p.id,
        label: p.label,
        kind: kindOf(p),
        npm: p.npm,
        baseUrl: p.baseUrl,
        connected: matched.length > 0,
        connectedId: matched[0]?.name ?? null,
        featured: p.featured,
        costClass: p.costClass,
        dataUse: p.dataUse,
        doc: p.doc,
        env: p.env,
        unsupportedReason: p.unsupportedReason,
        models,
      };
    });
  }

  async connect(input: { providerId: string; apiKey?: string; baseUrl?: string }): Promise<ProviderDTO> {
    const preset = CATALOG.find((p) => p.id === input.providerId);
    if (!preset) throw new Error(`Unknown provider: ${input.providerId}`);
    if (preset.unsupportedReason) throw new Error(`${preset.label} is not supported: ${preset.unsupportedReason}`);
    const needsKey = preset.auth !== 'none';
    if (needsKey && !input.apiKey) throw new Error(`An API key is required for ${preset.label}`);
    const isCustom = preset.id === 'custom';
    if (isCustom && !input.baseUrl) throw new Error('A base URL is required for a custom endpoint');
    const baseUrl = isCustom ? (input.baseUrl as string).replace(/\/+$/, '') : preset.baseUrl;
    if (isCustom && !/^https?:\/\//i.test(baseUrl)) throw new Error('The base URL must start with http:// or https://');
    // Every preset must carry a plain http(s) base URL: an empty one or one holding a
    // `$`-env placeholder cannot be turned into a working gateway target.
    if (!isCustom && (!/^https?:\/\//i.test(baseUrl) || baseUrl.includes('$'))) {
      throw new Error(`${preset.label} needs a platform-specific gateway base URL, which this app cannot supply (yet)`);
    }

    const id = isCustom ? this.uniqueCustomId(baseUrl) : preset.id;
    const key = input.apiKey ?? `local-${id}`;

    await this.deps.vault.saveKey(id, key);
    this.upsertProvider(id, preset, baseUrl);
    await this.upsertModels(id, preset, isCustom, baseUrl, key);
    const row = this.deps.db.select().from(providers).where(eq(providers.name, id)).get();
    if (!row) throw new Error(`Could not store the provider ${id}`);
    if (isCustom) return this.rowDto(row, preset);
    // A catalog provider has exactly one row, so `list()` carries it under this id.
    const dto = this.list().find((p) => p.id === id);
    if (!dto) throw new Error(`Could not store the provider ${id}`);
    return dto;
  }

  remove(providerId: string): void {
    const row = this.connectedRows().get(providerId);
    if (!row) return;
    void this.deps.vault.deleteKey(providerId);
    this.deps.db.delete(modelProfiles).where(eq(modelProfiles.providerId, row.id)).run();
    this.deps.db.delete(providers).where(eq(providers.id, row.id)).run();
    const current = this.getDefaultModel();
    if (current && current.providerId === providerId) this.setDefaultModel(null);
  }

  getConnected(): ConnectedProvider[] {
    const out: ConnectedProvider[] = [];
    for (const [id, row] of this.connectedRows()) {
      const preset = CATALOG.find((p) => p.id === row.presetKey);
      out.push({
        id,
        kind: row.kind,
        npm: preset?.npm ?? '@ai-sdk/openai-compatible',
        baseUrl: row.baseUrl,
        auth: preset?.auth ?? 'bearer',
        modelIds: this.modelsOf(row.id).map((m) => m.modelId),
      });
    }
    return out;
  }

  getDefaultModel(): { providerId: string; modelId: string } | null {
    const row = this.deps.db.select().from(appSettings).where(eq(appSettings.key, DEFAULT_MODEL_KEY)).get();
    if (!row) return null;
    const value = row.value as { providerId?: string; modelId?: string } | null;
    if (!value?.providerId || !value?.modelId) return null;
    return { providerId: value.providerId, modelId: value.modelId };
  }

  setDefaultModel(model: { providerId: string; modelId: string } | null): void {
    if (model === null) {
      this.deps.db.delete(appSettings).where(eq(appSettings.key, DEFAULT_MODEL_KEY)).run();
      return;
    }
    const row = this.connectedRows().get(model.providerId);
    if (!row) throw new Error(`Unknown provider: ${model.providerId}`);
    this.deps.db
      .insert(appSettings)
      .values({ key: DEFAULT_MODEL_KEY, value: model, updatedAt: new Date(this.deps.now()) })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: model, updatedAt: new Date(this.deps.now()) } })
      .run();
  }

  /** Records that a provider answered 429, so the UI can say the quota is exhausted. */
  markQuotaExhausted(providerId: string, status: number, until: number | null): void {
    const row = this.connectedRows().get(providerId);
    if (!row) return;
    this.deps.db
      .update(providers)
      .set({ quotaState: { exhaustedUntil: until, lastStatus: status, remaining: null } })
      .where(eq(providers.id, row.id))
      .run();
  }

  // ── internals ────────────────────────────────────────────────────────────────────

  private connectedRows(): Map<string, typeof providers.$inferSelect> {
    const map = new Map<string, typeof providers.$inferSelect>();
    for (const row of this.deps.db.select().from(providers).all()) {
      if (row.enabled) map.set(row.name, row);
    }
    return map;
  }

  private modelsOf(providerRowId: number) {
    return this.deps.db.select().from(modelProfiles).where(eq(modelProfiles.providerId, providerRowId)).all();
  }

  private uniqueCustomId(baseUrl: string): string {
    const base = `custom-${slugOf(baseUrl)}`;
    const taken = new Set([...this.connectedRows().keys()]);
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  private upsertProvider(id: string, preset: CatalogProvider, baseUrl: string): void {
    const existing = this.deps.db.select().from(providers).where(eq(providers.name, id)).get();
    const values = {
      presetKey: preset.id,
      name: id,
      kind: kindOf(preset),
      baseUrl,
      keyRef: `keyring:provider/${id}`,
      costClass: preset.costClass,
      dataUse: preset.dataUse,
      enabled: true,
    };
    if (existing) {
      this.deps.db.update(providers).set(values).where(eq(providers.id, existing.id)).run();
      return;
    }
    this.deps.db.insert(providers).values(values).run();
  }

  private async upsertModels(id: string, preset: CatalogProvider, isCustom: boolean, baseUrl: string, key: string): Promise<void> {
    const row = this.deps.db.select().from(providers).where(eq(providers.name, id)).get();
    if (!row) return;
    this.deps.db.delete(modelProfiles).where(eq(modelProfiles.providerId, row.id)).run();
    if (isCustom) {
      // Custom-endpoint semantics: the endpoint is the only model source — no catalog
      // models exist to fall back to.
      const ids = await this.discoverEndpointModels(baseUrl, key);
      this.insertModels(row.id, ids.map(toDiscoveredModel));
      return;
    }
    if (preset.auth === 'none') {
      // Local servers (ollama, lmstudio) list whatever the user has loaded, so ask the live
      // endpoint; a silent endpoint falls back to the catalog's representative models.
      const ids = await this.discoverEndpointModels(baseUrl, key);
      const models = ids.length > 0
        ? ids.map(toDiscoveredModel)
        : preset.models.map((m) => ({ modelId: m.id, name: m.name, contextLimit: m.contextLimit, outputLimit: m.outputLimit }));
      this.insertModels(row.id, models);
      return;
    }
    this.insertModels(
      row.id,
      preset.models.map((m) => ({ modelId: m.id, name: m.name, contextLimit: m.contextLimit, outputLimit: m.outputLimit })),
    );
  }

  private insertModels(
    providerRowId: number,
    models: { modelId: string; name: string; contextLimit: number; outputLimit: number }[],
  ): void {
    for (const m of models) {
      this.deps.db
        .insert(modelProfiles)
        .values({
          providerId: providerRowId,
          modelId: m.modelId,
          family: m.name,
          contextLimit: m.contextLimit,
          outputLimit: m.outputLimit,
          enabled: true,
        })
        .run();
    }
  }

  private async discoverEndpointModels(baseUrl: string, key: string): Promise<string[]> {
    const discover = this.deps.discoverModels ?? discoverModelsFromEndpoint;
    return discover(baseUrl, key);
  }

  /** The DTO of one connected row — what `connect` hands back for a custom endpoint. */
  private rowDto(row: typeof providers.$inferSelect, preset: CatalogProvider | undefined): ProviderDTO {
    const models: ProviderModelDTO[] = this.modelsOf(row.id).map((m) => ({
      id: m.modelId,
      name: m.family ?? m.modelId,
      contextLimit: m.contextLimit,
      outputLimit: m.outputLimit,
      inputCost: null,
      outputCost: null,
    }));
    return {
      id: preset?.id ?? row.name,
      label: preset?.label ?? row.name,
      kind: row.kind,
      npm: preset?.npm ?? '@ai-sdk/openai-compatible',
      baseUrl: row.baseUrl,
      connected: true,
      connectedId: row.name,
      featured: preset?.featured ?? false,
      costClass: row.costClass,
      dataUse: row.dataUse,
      doc: preset?.doc ?? null,
      env: preset?.env ?? [],
      unsupportedReason: preset?.unsupportedReason ?? null,
      models,
    };
  }
}
