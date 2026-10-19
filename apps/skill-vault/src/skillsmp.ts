// apps/skill-vault/src/skillsmp.ts — SkillsMP catalog access (REST + MCP) and the discovery pipeline.
// Verified public interfaces (2026-10-18, see docs/skill-vault/source-discovery.md):
//   REST  GET /api/v1/skills/search  — anonymous 50/day, 10/min, window ≤1000, hasNext traversal
//   MCP   POST /mcp                  — search_skills / get_skill / list_categories, 30 calls/min, no daily quota
import { z } from 'zod';
import type { Logger } from './log.ts';
import { McpClient } from './mcp.ts';
import type { PoliteHttpClient } from './http.ts';

export const skillSearchItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  author: z.string(),
  description: z.string(),
  contentLanguage: z.string().nullable().optional(),
  githubUrl: z.string(),
  skillUrl: z.string(),
  stars: z.number().int().default(0),
  updatedAt: z.number().int().nullable().optional(),
});
export type SkillSearchItem = z.infer<typeof skillSearchItemSchema>;

export const restSearchResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      skills: z.array(skillSearchItemSchema),
      pagination: z
        .object({
          page: z.number(),
          limit: z.number(),
          total: z.number().optional(),
          totalPages: z.number().optional(),
          hasNext: z.boolean().optional(),
          totalIsExact: z.boolean().optional(),
          isCapped: z.boolean().optional(),
          maxResults: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type RestSearchResponse = z.infer<typeof restSearchResponseSchema>;

export type CategoryInfo = { slug: string; label?: string; count?: number };

export type SearchPage = {
  items: SkillSearchItem[];
  page: number;
  hasNext: boolean;
  total: number | undefined;
  totalIsExact: boolean;
};

/** Adapt an MCP search_skills result (shape can be array or {skills,pagination}) into a SearchPage. */
const mcpResultToPage = (raw: unknown, page: number, limit: number): SearchPage => {
  let items: SkillSearchItem[] = [];
  let hasNext = false;
  let total: number | undefined;
  let totalIsExact = false;
  if (Array.isArray(raw)) {
    items = raw.map((item) => skillSearchItemSchema.parse(item));
    hasNext = items.length === limit;
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const skills = (obj.skills ?? obj.results ?? obj.items) as unknown[];
    if (Array.isArray(skills)) items = skills.map((item) => skillSearchItemSchema.parse(item));
    const pagination = obj.pagination as Record<string, unknown> | undefined;
    if (pagination) {
      hasNext = pagination.hasNext === true;
      total = typeof pagination.total === 'number' ? pagination.total : undefined;
      totalIsExact = pagination.totalIsExact === true;
    } else {
      hasNext = items.length === limit;
    }
  }
  return { items, page, hasNext, total, totalIsExact };
};

export class SkillsmpClient {
  private readonly baseUrl: string;
  private readonly http: PoliteHttpClient;
  private readonly logger: Logger;
  private mcp: McpClient | undefined;

  constructor(baseUrl: string, http: PoliteHttpClient, logger: Logger) {
    this.baseUrl = baseUrl;
    this.http = http;
    this.logger = logger;
  }

  private mcpClient(): McpClient {
    if (this.mcp === undefined) this.mcp = new McpClient(`${this.baseUrl}/mcp`, this.http);
    return this.mcp;
  }

  async health(): Promise<boolean> {
    try {
      const body = await this.http.getJson<{ status?: string }>(`${this.baseUrl}/api/health`, 64 * 1024);
      return body.status === 'ok';
    } catch {
      return false;
    }
  }

  async restSearch(params: {
    q: string;
    category?: string;
    page?: number;
    limit?: number;
    sortBy?: 'stars' | 'recent';
  }): Promise<SearchPage> {
    const url = new URL(`${this.baseUrl}/api/v1/skills/search`);
    url.searchParams.set('q', params.q);
    if (params.category !== undefined) url.searchParams.set('category', params.category);
    url.searchParams.set('page', String(params.page ?? 1));
    url.searchParams.set('limit', String(params.limit ?? 50));
    if (params.sortBy !== undefined) url.searchParams.set('sortBy', params.sortBy);
    const parsed = restSearchResponseSchema.parse(await this.http.getJson(url.toString(), 5 * 1024 * 1024));
    if (!parsed.success || parsed.data === undefined) {
      throw new Error(`SkillsMP search failed: ${parsed.error?.code ?? 'unknown'} ${parsed.error?.message ?? ''}`);
    }
    const pagination = parsed.data.pagination;
    return {
      items: parsed.data.skills,
      page: pagination?.page ?? params.page ?? 1,
      hasNext: pagination?.hasNext ?? parsed.data.skills.length === (params.limit ?? 50),
      total: pagination?.total,
      totalIsExact: pagination?.totalIsExact === true,
    };
  }

  async mcpSearch(params: {
    q?: string;
    category?: string;
    page?: number;
    limit?: number;
  }): Promise<SearchPage> {
    const client = this.mcpClient();
    const tools = await client.listTools().catch(() => [] as never[]);
    const searchTool = tools.find((tool) => tool.name === 'search_skills');
    const args = McpClient.adaptArgs(
      searchTool,
      {
        query: params.q ?? '',
        category: params.category,
        page: params.page ?? 1,
        limit: params.limit ?? 50,
      },
    );
    const raw = await client.callTool<unknown>('search_skills', args);
    return mcpResultToPage(raw, params.page ?? 1, params.limit ?? 50);
  }

  async mcpListCategories(): Promise<CategoryInfo[]> {
    const client = this.mcpClient();
    const raw = await client.callTool<unknown>('list_categories', {});
    const out: CategoryInfo[] = [];
    const pushItem = (item: unknown): void => {
      if (typeof item === 'string') {
        out.push({ slug: item });
        return;
      }
      const obj = (item ?? {}) as Record<string, unknown>;
      out.push({
        slug: String(obj.slug ?? obj.id ?? obj.name ?? ''),
        label: typeof obj.name === 'string' ? obj.name : typeof obj.label === 'string' ? obj.label : undefined,
        count: typeof obj.count === 'number' ? obj.count : undefined,
      });
    };
    if (Array.isArray(raw)) {
      for (const item of raw) pushItem(item);
    } else if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      // Newer servers return { domains: [{ domain, categories: [...] }] }
      if (Array.isArray(obj.domains)) {
        for (const domain of obj.domains) {
          const domainObj = (domain ?? {}) as Record<string, unknown>;
          if (Array.isArray(domainObj.categories)) {
            for (const category of domainObj.categories) pushItem(category);
          }
        }
      }
      for (const key of ['categories', 'items']) {
        if (Array.isArray(obj[key])) {
          for (const item of obj[key]) pushItem(item);
        }
      }
    }
    return out.filter((category) => category.slug.length > 0);
  }

  async mcpGetSkill(id: string): Promise<SkillSearchItem | undefined> {
    const client = this.mcpClient();
    const tools = await client.listTools().catch(() => [] as never[]);
    const tool = tools.find((t) => t.name === 'get_skill');
    const raw = await client.callTool<unknown>('get_skill', McpClient.adaptArgs(tool, { id }));
    if (raw === null || raw === undefined) return undefined;
    try {
      return skillSearchItemSchema.parse(raw);
    } catch {
      return undefined;
    }
  }

  /** Search one page via the best available transport. */
  async searchPage(params: {
    q?: string;
    category?: string;
    page?: number;
    limit?: number;
    transport: 'mcp' | 'rest';
  }): Promise<SearchPage> {
    if (params.transport === 'mcp') return this.mcpSearch(params);
    return this.restSearch({ q: params.q ?? '', category: params.category, page: params.page, limit: params.limit });
  }

  logTransportNote(transport: 'mcp' | 'rest'): void {
    this.logger.debug('skillsmp transport selected', { transport });
  }
}

/**
 * Heuristic classification of SkillsMP categories as coding-related.
 * The category list is fetched live from list_categories and classified with these
 * markers so a renamed or new category still lands correctly. Config overrides win.
 */
const CODING_MARKERS = [
  'coding',
  'code',
  'software',
  'develop',
  'dev ',
  'devops',
  'program',
  'engineer',
  'data',
  'ai',
  ' ml',
  'machine learning',
  'security',
  'web',
  'backend',
  'frontend',
  'full-stack',
  'fullstack',
  'testing',
  'debug',
  'refactor',
  'cloud',
  'architecture',
  'api',
  'database',
  'automation',
  'agent',
  'algorithm',
  'version control',
  'git',
];

export const isCodingCategory = (category: CategoryInfo): boolean => {
  const haystack = `${category.slug} ${category.label ?? ''}`.toLowerCase();
  return CODING_MARKERS.some((marker) => haystack.includes(marker));
};

/** Skill-level coding heuristic used when a category is missing or unclassified. */
const CODING_NAME_MARKERS = [
  'code',
  'coding',
  'refactor',
  'debug',
  'test',
  'tdd',
  'api',
  'typescript',
  'javascript',
  'python',
  'rust',
  'golang',
  'java',
  'c++',
  'react',
  'vue',
  'svelte',
  'node',
  'sql',
  'devops',
  'ci/cd',
  'lint',
  'code-review',
  'codebase',
  'backend',
  'frontend',
  'git',
  'commit',
  'security',
  'performance',
];

export const looksLikeCodingSkill = (item: SkillSearchItem): boolean => {
  const haystack = `${item.name} ${item.description}`.toLowerCase();
  return CODING_NAME_MARKERS.some((marker) => haystack.includes(marker));
};
