// apps/orchestrator/test/default-model.test.ts — Task 8: the stored default model drives the
// agent runtime. The runtime already implements the precedence (explicit > configured default
// > server discovery); these tests lock it, and `app.ts` wires the ProviderService's stored
// default into the constructor.
import { describe, expect, it } from 'vitest';
import { OpenCodeRuntime } from '../src/agents/runtime.ts';

describe('OpenCodeRuntime.resolveModel', () => {
  it('prefers the configured default model', async () => {
    const runtime = new OpenCodeRuntime({ defaultModel: { providerID: 'zai', id: 'glm-4.6' } });
    expect(await runtime.resolveModel()).toEqual({ providerID: 'zai', id: 'glm-4.6' });
  });

  it('prefers an explicit model over the default', async () => {
    const runtime = new OpenCodeRuntime({ defaultModel: { providerID: 'zai', id: 'glm-4.6' } });
    expect(await runtime.resolveModel({ providerID: 'openai', id: 'gpt-4o' })).toEqual({ providerID: 'openai', id: 'gpt-4o' });
  });
});
