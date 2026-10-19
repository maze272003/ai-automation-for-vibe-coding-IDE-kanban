// apps/skill-vault/src/config.ts — validated vault configuration.
import path from 'node:path';
import { readJsonIfExists, writeFileAtomic } from './util.ts';
import { z } from 'zod';

export const sourceConfigSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('skillsmp'),
  enabled: z.boolean().default(true),
  baseUrl: z.url().default('https://skillsmp.com'),
  transport: z.enum(['auto', 'mcp', 'rest', 'sitemap']).default('auto'),
});

export const vaultConfigSchema = z.object({
  version: z.literal(1).default(1),
  userAgent: z
    .string()
    .default('aikanban-skill-vault/0.1 (+https://github.com/local; respects robots and rate limits)'),
  sources: z.array(sourceConfigSchema).min(1).prefault([{ id: 'skillsmp', kind: 'skillsmp' }]),
  coding: z
    .object({
      // Category slugs treated as coding-related. Empty means "auto-classify with heuristics".
      categories: z.array(z.string()).default([]),
      extraKeywords: z.array(z.string()).default([]),
      includeUnclassified: z.boolean().default(false),
    })
    .prefault({}),
  download: z
    .object({
      concurrency: z.number().int().min(1).max(16).default(4),
      maxRetries: z.number().int().min(0).max(10).default(4),
      minRequestIntervalMs: z.number().int().min(0).default(250),
      requestTimeoutMs: z.number().int().min(1_000).default(30_000),
      maxArchiveBytes: z.number().int().min(1).default(100 * 1024 * 1024),
      maxFileBytes: z.number().int().min(1).default(10 * 1024 * 1024),
      maxFilesPerSkill: z.number().int().min(1).default(500),
      maxBytesPerSkill: z.number().int().min(1).default(25 * 1024 * 1024),
      minFreeDiskBytes: z.number().int().min(1).default(2 * 1024 * 1024 * 1024),
      githubApiBudgetPerRun: z.number().int().min(0).default(20),
    })
    .prefault({}),
  scan: z
    .object({
      autoRejectOnCritical: z.boolean().default(true),
      disabledRules: z.array(z.string()).default([]),
    })
    .prefault({}),
  search: z
    .object({
      defaultStatuses: z.array(z.string()).default(['scanned', 'approved']),
    })
    .prefault({}),
  integration: z
    .object({
      opencode: z
        .object({
          projectSkillsDir: z.string().default('.opencode/skills'),
          globalSkillsDir: z.string().default(''),
        })
        .prefault({}),
      claudeCode: z
        .object({
          projectSkillsDir: z.string().default('.claude/skills'),
          globalSkillsDir: z.string().default(''),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type VaultConfig = z.infer<typeof vaultConfigSchema>;

export const loadConfig = async (configDir: string): Promise<VaultConfig> => {
  const raw = await readJsonIfExists<unknown>(path.join(configDir, 'vault.config.json'));
  if (raw === undefined) return vaultConfigSchema.parse({});
  return vaultConfigSchema.parse(raw);
};

export const saveConfig = async (configDir: string, config: VaultConfig): Promise<void> => {
  await writeFileAtomic(path.join(configDir, 'vault.config.json'), `${JSON.stringify(config, null, 2)}\n`);
};
