// packages/providers/src/index.ts — the provider catalog the app connects to.
import { OVERRIDES } from './catalog.overrides.ts';
import { RAW_CATALOG } from './catalog.data.ts';
import type { CatalogModel, CatalogOverrides, CatalogProvider, CostClass } from './types.ts';

export * from './types.ts';

interface RawModel {
  id?: string;
  name?: string;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
  tool_call?: boolean;
  reasoning?: boolean;
}

interface RawProvider {
  id?: string;
  name?: string;
  env?: string[];
  npm?: string;
  api?: string;
  doc?: string;
  models?: Record<string, RawModel>;
}

const DEFAULT_CONTEXT = 128_000;
const DEFAULT_OUTPUT = 8_192;

function toModel(id: string, raw: RawModel): CatalogModel {
  return {
    id,
    name: raw.name ?? id,
    contextLimit: raw.limit?.context ?? DEFAULT_CONTEXT,
    outputLimit: raw.limit?.output ?? DEFAULT_OUTPUT,
    inputCost: typeof raw.cost?.input === 'number' ? raw.cost.input : null,
    outputCost: typeof raw.cost?.output === 'number' ? raw.cost.output : null,
    toolCall: raw.tool_call !== false,
    reasoning: raw.reasoning === true,
  };
}

function deriveCostClass(models: CatalogModel[], local: boolean): CostClass {
  if (local) return 'local';
  if (models.length === 0) return 'paid_metered';
  const priced = models.filter((m) => m.inputCost !== null || m.outputCost !== null);
  if (priced.length === 0) return 'free_limited';
  const free = priced.filter((m) => (m.inputCost ?? 0) === 0 && (m.outputCost ?? 0) === 0);
  if (free.length === priced.length) return 'free';
  if (free.length > 0) return 'free_limited';
  return 'paid_metered';
}

export function buildCatalog(raw: Record<string, unknown>, overrides: CatalogOverrides): CatalogProvider[] {
  const out: CatalogProvider[] = [];
  for (const [id, value] of Object.entries(raw as Record<string, RawProvider>)) {
    // Deviation from the plan (required by it): a hand-verified local entry shadows a
    // same-named models.dev entry, so `lmstudio` keeps `auth: 'none'` despite models.dev
    // also listing it as a hosted-shaped provider.
    if (overrides.localEntries[id]) continue;
    const p = value ?? {};
    const npm = p.npm ?? '';
    const protocol = overrides.protocolByNpm[npm];
    const unsupportedReason = protocol ? null : (overrides.unsupportedNpm[npm] ?? 'Protocol not verified');
    const models = Object.entries(p.models ?? {}).map(([modelId, m]) => toModel(modelId, m as RawModel));
    const baseUrl = p.api ?? overrides.baseUrl[id] ?? '';
    out.push({
      id,
      label: p.name ?? id,
      protocol: protocol ?? 'openai_compatible',
      npm,
      baseUrl,
      auth: protocol ? overrides.authByProtocol[protocol] : 'bearer',
      env: p.env ?? [],
      doc: p.doc ?? null,
      costClass: deriveCostClass(models, false),
      dataUse: 'unknown',
      featured: overrides.featured.includes(id),
      unsupportedReason,
      models,
    });
  }
  for (const [id, local] of Object.entries(overrides.localEntries)) {
    out.push({
      id,
      label: local.label,
      protocol: 'openai_compatible',
      npm: local.npm,
      baseUrl: local.baseUrl,
      auth: local.auth,
      env: [],
      doc: local.doc,
      costClass: deriveCostClass(local.models, true),
      dataUse: 'no_training',
      featured: overrides.featured.includes(id),
      unsupportedReason: null,
      models: local.models,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export const CATALOG: readonly CatalogProvider[] = buildCatalog(RAW_CATALOG, OVERRIDES);

export function findProvider(id: string): CatalogProvider | undefined {
  return CATALOG.find((p) => p.id === id);
}

export function featuredProviders(): CatalogProvider[] {
  return CATALOG.filter((p) => p.featured);
}

export function searchProviders(query: string): CatalogProvider[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...CATALOG];
  // Deviation from the plan (required by it): the plan's own test searches `glm` and
  // expects `zhipuai`, but zhipuai's id, label and env hold no "glm" — only its model
  // ids do (glm-4.6, glm-5, …). So the search also scans model ids and names.
  const hit = (s: string): boolean => s.toLowerCase().includes(q);
  return CATALOG.filter(
    (p) =>
      hit(p.id) ||
      hit(p.label) ||
      p.env.some(hit) ||
      p.models.some((m) => hit(m.id) || hit(m.name)),
  );
}
