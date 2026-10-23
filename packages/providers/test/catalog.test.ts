import { describe, expect, it } from 'vitest';
import { CATALOG, findProvider, featuredProviders, searchProviders } from '../src/index.ts';
import { buildCatalog } from '../src/index.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const fixture = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'fixtures', 'models-dev.sample.json'), 'utf8'),
) as Record<string, unknown>;

describe('buildCatalog', () => {
  it('maps a models.dev payload into catalog providers', () => {
    const catalog = buildCatalog(fixture, {
      baseUrl: {},
      protocolByNpm: { '@ai-sdk/openai-compatible': 'openai_compatible' },
      authByProtocol: { openai_compatible: 'bearer', anthropic: 'x-api-key', google: 'x-goog-api-key', openai: 'bearer' },
      unsupportedNpm: {},
      featured: ['mockai'],
      localEntries: {},
    });
    const provider = catalog.find((p) => p.id === 'mockai');
    expect(provider).toBeDefined();
    expect(provider?.npm).toBe('@ai-sdk/openai-compatible');
    expect(provider?.auth).toBe('bearer');
    expect(provider?.baseUrl).toBe('https://mockai.test/v1');
    expect(provider?.models[0]).toMatchObject({ id: 'mock-model', contextLimit: 131072, outputLimit: 8192 });
  });

  it('derives the cost class from the model prices', () => {
    const catalog = buildCatalog(fixture, {
      baseUrl: {},
      protocolByNpm: { '@ai-sdk/openai-compatible': 'openai_compatible' },
      authByProtocol: { openai_compatible: 'bearer', anthropic: 'x-api-key', google: 'x-goog-api-key', openai: 'bearer' },
      unsupportedNpm: {},
      featured: [],
      localEntries: {},
    });
    // The fixture's model costs 0.5/1.5 -> paid; the second costs 0/0 -> free_limited.
    expect(catalog.find((p) => p.id === 'mockai')?.costClass).toBe('paid_metered');
    expect(catalog.find((p) => p.id === 'freeai')?.costClass).toBe('free_limited');
  });

  it('marks a provider unsupported when its package is not in the protocol map', () => {
    const catalog = buildCatalog(fixture, {
      baseUrl: {},
      protocolByNpm: {},
      authByProtocol: { openai_compatible: 'bearer', anthropic: 'x-api-key', google: 'x-goog-api-key', openai: 'bearer' },
      unsupportedNpm: { '@ai-sdk/openai-compatible': 'not verified' },
      featured: [],
      localEntries: {},
    });
    expect(catalog.find((p) => p.id === 'mockai')?.unsupportedReason).toBe('not verified');
  });
});

describe('the committed catalog', () => {
  it('has at least 200 providers, each with a package, a base URL and models', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(200);
    for (const p of CATALOG) {
      expect(p.id, p.id).toMatch(/^[a-z0-9._-]+$/);
      expect(p.npm.length, p.id).toBeGreaterThan(0);
      // `custom` is the escape hatch: the user supplies its base URL and models.
      if (p.id === 'custom' || p.unsupportedReason) continue;
      expect(p.baseUrl.length, p.id).toBeGreaterThan(0);
      expect(p.models.length, p.id).toBeGreaterThan(0);
    }
  });

  it('includes the featured providers and the local ones', () => {
    for (const id of ['openai', 'anthropic', 'google', 'zai', 'zhipuai', 'openrouter', 'groq', 'deepseek', 'mistral', 'xai']) {
      expect(findProvider(id), id).toBeDefined();
    }
    expect(findProvider('ollama')?.auth).toBe('none');
    expect(findProvider('lmstudio')?.auth).toBe('none');
    expect(findProvider('custom')?.baseUrl).toBe('');
  });

  it('finds providers by search term and lists the featured ones first', () => {
    expect(searchProviders('glm').map((p) => p.id)).toContain('zhipuai');
    expect(searchProviders('zzzznotathing')).toHaveLength(0);
    const featured = featuredProviders();
    expect(featured.length).toBeGreaterThan(0);
    expect(featured.every((p) => p.featured)).toBe(true);
  });
});
