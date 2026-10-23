// apps/desktop/test/opencode-config.test.ts — Task 9: the virtual-provider config fragments.
// These are the only values OpenCode may know: its gateway token and its base URL never a
// provider API key.
import { describe, expect, it } from 'vitest';
import { buildProviderConfig } from '../src/main/opencode-config.ts';

describe('buildProviderConfig', () => {
  it('builds one virtual provider per connected upstream provider', () => {
    const config = buildProviderConfig({
      providers: [
        { id: 'zai', npm: '@ai-sdk/openai-compatible', models: [{ id: 'glm-4.6', name: 'GLM 4.6', contextLimit: 200000, outputLimit: 32768 }] },
        { id: 'anthropic', npm: '@ai-sdk/anthropic', models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextLimit: 200000, outputLimit: 64000 }] },
      ],
      gatewayBaseUrl: 'http://127.0.0.1:53123',
      gatewayToken: 'local-gateway-token',
    });

    expect(Object.keys(config)).toEqual(['anthropic', 'zai']);
    expect(config.zai!.npm).toBe('@ai-sdk/openai-compatible');
    expect(config.zai!.options.baseURL).toBe('http://127.0.0.1:53123');
    expect(config.zai!.options.apiKey).toBe('local-gateway-token');
    expect(config.zai!.options.headers).toEqual({ 'x-aik-provider': 'zai' });
    expect(config.zai!.models['glm-4.6']!.limit).toEqual({ context: 200000, output: 32768 });
    expect(config.anthropic!.npm).toBe('@ai-sdk/anthropic');
  });

  it('never contains a provider key — only the gateway token', () => {
    const config = buildProviderConfig({
      providers: [{ id: 'zai', npm: '@ai-sdk/openai-compatible', models: [{ id: 'glm-4.6', name: 'GLM 4.6', contextLimit: 1, outputLimit: 1 }] }],
      gatewayBaseUrl: 'http://127.0.0.1:1',
      gatewayToken: 'local-gateway-token',
    });
    expect(JSON.stringify(config)).not.toMatch(/sk-/);
  });

  it('returns an empty map when nothing is connected', () => {
    expect(buildProviderConfig({ providers: [], gatewayBaseUrl: 'http://127.0.0.1:1', gatewayToken: 't' })).toEqual({});
  });
});
