import { describe, expect, it } from 'vitest';
import {
  AGENT_PRESETS,
  ALLOWED_RUNTIMES,
  AUTO_EFFORTS,
  AgentsSettings,
  EFFORT,
  ModelChoice,
  ProjectSettings,
  ROLE,
  ROLE_LABELS,
  ROLE_TIMEOUTS_MS,
  RUNTIME_FAILURE,
  RUNTIME_KIND,
  RoleRoute,
  applyPreset,
  defaultProjectSettings,
} from '../src/index.ts';

const MIN = 60_000;

/** A full agents block on the legacy preset with the given overrides applied to roles/gates. */
const agentsWith = (patch: { roles?: Record<string, unknown>; gates?: Record<string, unknown>; qa?: Record<string, unknown> }) => {
  const base = structuredClone(AGENT_PRESETS['opencode-legacy']);
  return {
    ...base,
    roles: { ...base.roles, ...(patch.roles ?? {}) },
    gates: { ...base.gates, ...(patch.gates ?? {}) },
    qa: { ...base.qa, ...(patch.qa ?? {}) },
  };
};

const messagesOf = (result: { success: boolean; error?: { issues: { message: string }[] } }): string[] =>
  result.success ? [] : (result.error?.issues ?? []).map((i) => i.message);

describe('agent-team enums', () => {
  it('declares the five roles, three runtimes, efforts and runtime failures', () => {
    expect(ROLE).toEqual(['planner', 'implementer', 'reviewer', 'qa', 'security']);
    expect(RUNTIME_KIND).toEqual(['opencode', 'claude-code', 'codex']);
    expect(EFFORT).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(AUTO_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(RUNTIME_FAILURE).toEqual(['auth', 'quota', 'not_installed', 'timeout', 'budget', 'crashed', 'invalid_output']);
  });

  it('never chooses max or ultra automatically', () => {
    expect(AUTO_EFFORTS).not.toContain('max');
    expect(AUTO_EFFORTS).not.toContain('ultra');
  });

  it('labels the implementer "Coder" for the UI without making "coder" a role', () => {
    expect(ROLE_LABELS).toEqual({ planner: 'Planner', implementer: 'Coder', reviewer: 'Reviewer', qa: 'QA', security: 'Security' });
    expect(ROLE as readonly string[]).not.toContain('coder');
  });

  it('allows any runtime for planner/implementer/reviewer and only Claude Code or Codex for qa/security', () => {
    expect(ALLOWED_RUNTIMES).toEqual({
      planner: ['opencode', 'claude-code', 'codex'],
      implementer: ['opencode', 'claude-code', 'codex'],
      reviewer: ['opencode', 'claude-code', 'codex'],
      qa: ['claude-code', 'codex'],
      security: ['claude-code', 'codex'],
    });
  });

  it('sets the per-role timeouts in milliseconds', () => {
    expect(ROLE_TIMEOUTS_MS).toEqual({
      planner: 20 * MIN,
      implementer: 60 * MIN,
      reviewer: 20 * MIN,
      qa: 30 * MIN,
      qaFunctional: 15 * MIN,
      qaUi: 15 * MIN,
      security: 20 * MIN,
      chat: 5 * MIN,
    });
    expect(ROLE_TIMEOUTS_MS.qaFunctional + ROLE_TIMEOUTS_MS.qaUi).toBe(ROLE_TIMEOUTS_MS.qa);
  });
});

describe('ProjectSettings defaults (legacy preset, CLI budgets, protected paths)', () => {
  it('defaults agents to the opencode-legacy preset', () => {
    const s = ProjectSettings.parse({});
    expect(s.agents).toEqual(AGENT_PRESETS['opencode-legacy']);
    for (const role of ['planner', 'implementer', 'reviewer'] as const) {
      expect(s.agents.roles[role]).toEqual({ runtime: 'opencode', model: 'auto' });
    }
    expect(s.agents.gates).toEqual({ qa: false, qaUi: false, security: false });
    expect(s.agents.usePersonalSetup).toBe(false);
    expect(s.agents.maxSubagents).toBe(2);
    expect(s.agents.claudeMaxUsdPerRun).toBe(2);
    expect(s.agents.qa).toEqual({ commands: [], allowUiNetwork: false });
    expect(s.agents.preset).toBe('opencode-legacy');
  });

  it('keeps allowPaid off and adds the CLI budgets without changing the existing ones', () => {
    const s = ProjectSettings.parse({});
    expect(s.allowPaid).toBe(false);
    expect(s.budgets.commandsPerRun).toBe(300);
    expect(s.budgets.cliTokensPerStory).toBe(3_000_000);
    expect(s.budgets.requestsPerRun).toBe(300);
    expect(s.budgets.requestsPerStory).toBe(1000);
    expect(s.budgets.inputTokensPerStory).toBe(3_000_000);
  });

  it('fills the new budget fields into a stored budgets object that predates them', () => {
    const s = ProjectSettings.parse({ budgets: { requestsPerRun: 10, requestsPerStory: 20, inputTokensPerStory: 1000 } });
    expect(s.budgets).toEqual({
      requestsPerRun: 10, requestsPerStory: 20, inputTokensPerStory: 1000, commandsPerRun: 300, cliTokensPerStory: 3_000_000,
    });
  });

  it('flags agent configuration paths by default alongside the existing protected paths', () => {
    const paths = defaultProjectSettings().protectedPaths;
    for (const p of ['.claude/**', '.codex/**', '.mcp.json']) expect(paths).toContain(p);
    for (const p of ['.github/workflows/**', '.opencode/**', 'opencode.json*', '.husky/**', '.gitmodules', '.gitattributes']) {
      expect(paths).toContain(p);
    }
  });
});

describe('AGENT_PRESETS', () => {
  it('routes the 6.1a agent team: Claude plans/reviews/secures, OpenCode codes, Codex tests; gates off', () => {
    const team = AGENT_PRESETS['agent-team'];
    expect(team.preset).toBe('agent-team');
    expect(team.roles.planner).toEqual({ runtime: 'claude-code', model: 'claude-opus-5-5' });
    expect(team.roles.reviewer).toEqual({ runtime: 'claude-code', model: 'claude-opus-5-5' });
    expect(team.roles.implementer).toEqual({ runtime: 'opencode', model: 'auto' });
    expect(team.roles.qa).toEqual({ runtime: 'codex', model: 'auto' });
    expect(team.roles.security).toEqual({ runtime: 'claude-code', model: 'claude-opus-5-5' });
    expect(team.gates).toEqual({ qa: false, qaUi: false, security: false });
  });

  it('both presets are valid AgentsSettings', () => {
    for (const name of ['agent-team', 'opencode-legacy'] as const) {
      expect(AgentsSettings.parse(AGENT_PRESETS[name])).toEqual(AGENT_PRESETS[name]);
    }
  });

  it('cannot be mutated by a caller', () => {
    const legacy = AGENT_PRESETS['opencode-legacy'];
    expect(() => {
      (legacy.roles.planner as { runtime: string }).runtime = 'codex';
    }).toThrow();
    expect(legacy.roles.planner.runtime).toBe('opencode');
  });
});

describe('RoleRoute model and effort validation', () => {
  it("accepts model 'auto' for codex and opencode", () => {
    expect(RoleRoute.safeParse({ runtime: 'codex', model: 'auto' }).success).toBe(true);
    expect(RoleRoute.safeParse({ runtime: 'opencode', model: 'auto' }).success).toBe(true);
  });

  it("rejects model 'auto' for claude-code with a clear message", () => {
    const r = RoleRoute.safeParse({ runtime: 'claude-code', model: 'auto' });
    expect(r.success).toBe(false);
    expect(messagesOf(r)).toContain('auto is not valid for Claude Code; pick a model');
  });

  it('rejects model ids that could be read as flags or shell syntax', () => {
    for (const bad of ['--evil', '-x', 'x; rm', 'a b', 'opus"', "opus'", '', 'a'.repeat(101), 'x|y', 'x&y', '$(x)']) {
      expect(RoleRoute.safeParse({ runtime: 'codex', model: bad }).success, bad).toBe(false);
    }
  });

  it('accepts real model ids', () => {
    for (const ok of ['claude-opus-5-5', 'opus[1m]', 'gpt-6-astra', 'provider.x', 'a:b', 'a'.repeat(100)]) {
      expect(RoleRoute.safeParse({ runtime: 'claude-code', model: ok }).success, ok).toBe(true);
    }
  });

  it('accepts max and ultra only as explicit overrides and rejects unknown efforts', () => {
    expect(RoleRoute.safeParse({ runtime: 'codex', model: 'auto', effort: 'ultra' }).success).toBe(true);
    expect(RoleRoute.safeParse({ runtime: 'codex', model: 'auto', effort: 'max' }).success).toBe(true);
    expect(RoleRoute.safeParse({ runtime: 'codex', model: 'auto', effort: 'extreme' }).success).toBe(false);
  });

  it('accepts an integer timeoutMin override and rejects nonsense', () => {
    expect(RoleRoute.parse({ runtime: 'codex', model: 'auto', timeoutMin: 7 }).timeoutMin).toBe(7);
    for (const bad of [0, -1, 1.5]) {
      expect(RoleRoute.safeParse({ runtime: 'codex', model: 'auto', timeoutMin: bad }).success, String(bad)).toBe(false);
    }
  });

  it('rejects an unknown runtime', () => {
    expect(RoleRoute.safeParse({ runtime: 'gemini', model: 'auto' }).success).toBe(false);
  });
});

describe('AgentsSettings', () => {
  it('rejects maxSubagents outside 0–4', () => {
    expect(AgentsSettings.safeParse({ ...agentsWith({}), maxSubagents: 5 }).success).toBe(false);
    expect(AgentsSettings.safeParse({ ...agentsWith({}), maxSubagents: -1 }).success).toBe(false);
    expect(AgentsSettings.safeParse({ ...agentsWith({}), maxSubagents: 1.5 }).success).toBe(false);
    expect(AgentsSettings.safeParse({ ...agentsWith({}), maxSubagents: 0 }).success).toBe(true);
    expect(AgentsSettings.safeParse({ ...agentsWith({}), maxSubagents: 4 }).success).toBe(true);
  });

  it('rejects a non-positive Claude budget', () => {
    expect(AgentsSettings.safeParse({ ...agentsWith({}), claudeMaxUsdPerRun: 0 }).success).toBe(false);
    expect(AgentsSettings.safeParse({ ...agentsWith({}), claudeMaxUsdPerRun: -2 }).success).toBe(false);
  });

  it('defaults qa.allowUiNetwork to false', () => {
    expect(AgentsSettings.parse({ ...agentsWith({}), qa: { commands: ['npm test'] } }).qa.allowUiNetwork).toBe(false);
  });

  describe('qa.devServerUrl', () => {
    const withUrl = (devServerUrl: string) => AgentsSettings.safeParse(agentsWith({ qa: { devServerUrl } }));

    it('accepts loopback URLs with the {port} placeholder', () => {
      expect(withUrl('http://127.0.0.1:{port}').success).toBe(true);
      expect(withUrl('http://localhost:{port}/app').success).toBe(true);
    });

    it('rejects non-loopback hosts', () => {
      for (const bad of ['http://evil.com', 'http://evil.com:{port}', 'http://localhost.evil.com:{port}', 'http://127.0.0.1.evil.com:{port}']) {
        expect(withUrl(bad).success, bad).toBe(false);
      }
    });

    it('allows {port} as the only placeholder', () => {
      for (const bad of ['http://localhost:{host}', 'http://{host}:{port}', 'http://localhost:{port}/{path}', 'http://localhost:{PORT}']) {
        expect(withUrl(bad).success, bad).toBe(false);
      }
    });

    it('rejects userinfo, whitespace and non-http schemes', () => {
      for (const bad of ['http://user@localhost:{port}', 'http://localhost:{port}/a b', 'file:///etc/passwd', 'javascript:alert(1)']) {
        expect(withUrl(bad).success, bad).toBe(false);
      }
    });
  });

  describe('T12: QA and security need Claude Code or Codex when their gate is on', () => {
    it('rejects an enabled QA gate routed to OpenCode', () => {
      const r = AgentsSettings.safeParse(agentsWith({ gates: { qa: true }, roles: { qa: { runtime: 'opencode', model: 'auto' } } }));
      expect(r.success).toBe(false);
      expect(messagesOf(r)).toContain('QA needs Claude Code or Codex');
    });

    it('rejects an enabled UI QA gate routed to OpenCode', () => {
      const r = AgentsSettings.safeParse(agentsWith({ gates: { qaUi: true }, roles: { qa: { runtime: 'opencode', model: 'auto' } } }));
      expect(r.success).toBe(false);
      expect(messagesOf(r)).toContain('QA needs Claude Code or Codex');
    });

    it('rejects an enabled security gate routed to OpenCode', () => {
      const r = AgentsSettings.safeParse(agentsWith({ gates: { security: true }, roles: { security: { runtime: 'opencode', model: 'auto' } } }));
      expect(r.success).toBe(false);
      expect(messagesOf(r)).toContain('Security needs Claude Code or Codex');
    });

    it('accepts gates off with OpenCode routes (the legacy preset)', () => {
      expect(AgentsSettings.safeParse(agentsWith({})).success).toBe(true);
      expect(AGENT_PRESETS['opencode-legacy'].roles.qa.runtime).toBe('opencode');
      expect(AGENT_PRESETS['opencode-legacy'].roles.security.runtime).toBe('opencode');
    });

    it('accepts enabled gates routed to Claude Code or Codex', () => {
      const r = AgentsSettings.safeParse(agentsWith({
        gates: { qa: true, qaUi: true, security: true },
        roles: { qa: { runtime: 'codex', model: 'auto' }, security: { runtime: 'claude-code', model: 'claude-opus-5-5' } },
      }));
      expect(r.success).toBe(true);
    });
  });

  it('is enforced through ProjectSettings', () => {
    const r = ProjectSettings.safeParse({ agents: agentsWith({ gates: { qa: true } }) });
    expect(r.success).toBe(false);
    expect(messagesOf(r)).toContain('QA needs Claude Code or Codex');
  });
});

describe('applyPreset', () => {
  const customised = () => ProjectSettings.parse({
    checks: [{ key: 'test', command: 'npm test', mandatory: true }],
    publish: true,
    remoteMerge: true,
    autoAcceptPlans: true,
    budgets: { requestsPerRun: 11, requestsPerStory: 22, inputTokensPerStory: 33, commandsPerRun: 44, cliTokensPerStory: 55 },
    protectedPaths: ['custom/**'],
  });

  it('agent-team writes the resolved roles and sets allowPaid', () => {
    const before = customised();
    const after = applyPreset(before, 'agent-team');
    expect(after.allowPaid).toBe(true);
    expect(after.agents.preset).toBe('agent-team');
    expect(after.agents.roles).toEqual(AGENT_PRESETS['agent-team'].roles);
    expect(after.agents.gates).toEqual(AGENT_PRESETS['agent-team'].gates);
    expect(ProjectSettings.safeParse(after).success).toBe(true);
  });

  it('leaves publish, remoteMerge, autoAcceptPlans, checks, budgets and protectedPaths untouched', () => {
    const before = customised();
    const after = applyPreset(before, 'agent-team');
    expect(after.publish).toBe(before.publish);
    expect(after.remoteMerge).toBe(before.remoteMerge);
    expect(after.autoAcceptPlans).toBe(before.autoAcceptPlans);
    expect(after.checks).toEqual(before.checks);
    expect(after.budgets).toEqual(before.budgets);
    expect(after.protectedPaths).toEqual(before.protectedPaths);
  });

  it('does not mutate its input and does not share objects with the preset table', () => {
    const before = customised();
    const snapshot = structuredClone(before);
    const after = applyPreset(before, 'agent-team');
    expect(before).toEqual(snapshot);
    after.agents.roles.planner.model = 'something-else';
    expect(AGENT_PRESETS['agent-team'].roles.planner.model).toBe('claude-opus-5-5');
  });

  it('switching back to legacy restores OpenCode routes but does not clear allowPaid (M8)', () => {
    const team = applyPreset(customised(), 'agent-team');
    const legacy = applyPreset(team, 'opencode-legacy');
    expect(legacy.agents.roles).toEqual(AGENT_PRESETS['opencode-legacy'].roles);
    expect(legacy.agents.preset).toBe('opencode-legacy');
    expect(legacy.allowPaid).toBe(true);
  });

  it('keeps the project QA commands, dev-server settings and network consent', () => {
    const base = customised();
    const before = { ...base, agents: { ...base.agents, qa: { commands: ['npm run e2e'], devServerCommand: 'npm run dev -- --port {port}', devServerUrl: 'http://127.0.0.1:{port}', allowUiNetwork: true } } };
    const after = applyPreset(before, 'agent-team');
    expect(after.agents.qa).toEqual(before.agents.qa);
  });
});

describe('ModelChoice', () => {
  it('records runtime, model, effort (nullable) and reason', () => {
    expect(ModelChoice.parse({ runtime: 'codex', model: 'gpt-6-astra', effort: 'high', reason: 'L story, rework #1' })).toEqual({
      runtime: 'codex', model: 'gpt-6-astra', effort: 'high', reason: 'L story, rework #1',
    });
    expect(ModelChoice.parse({ runtime: 'claude-code', model: 'claude-opus-5-5', effort: null, reason: 'role override' }).effort).toBeNull();
    expect(ModelChoice.safeParse({ runtime: 'claude-code', model: 'claude-opus-5-5', reason: 'x' }).success).toBe(false);
  });
});
