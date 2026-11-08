// apps/orchestrator/test/plan-parse.test.ts
import { describe, expect, it } from 'vitest';
import type { PlanV1 } from '@aik/contracts';
import { parsePlanText } from '../src/agents/plan-parse.ts';

const plan: PlanV1 = {
  schemaVersion: 1,
  summary: 'Add the approvals view backed by the existing plans table.',
  assumptions: ['The plans table already records who approved.'],
  clarificationQuestions: [],
  acceptanceCriteria: [
    { ref: 'AC-1', text: 'The approvals view lists every plan version', testable: true, verification: 'npm test approvals' },
  ],
  subtasks: [{ id: '1', description: 'Render the approvals view', files: ['apps/ui/src/routes/approvals.tsx'] }],
  affectedFiles: [],
  requiredTests: [],
  migrations: { required: false, notes: '' },
  securitySensitive: [],
  dependencyChanges: [],
  conflictsWith: [],
  complexity: 'S',
  risks: ['Reviewers may approve a stale plan version.'],
};

describe('parsePlanText', () => {
  it('parses a fenced ```json block inside prose', () => {
    const text = `Sure — here is the plan:\n\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\nLet me know.`;
    expect(parsePlanText(text)).toEqual({ ok: true, plan });
  });

  it('parses bare JSON', () => {
    expect(parsePlanText(JSON.stringify(plan))).toEqual({ ok: true, plan });
  });

  it('rejects prose with the JSON parse error', () => {
    const res = parsePlanText('Here is how I would implement it: first, we add a column.');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/JSON/);
  });

  it('rejects valid JSON missing subtasks, naming the field', () => {
    const withoutSubtasks: Record<string, unknown> = { ...plan };
    delete withoutSubtasks.subtasks;
    const res = parsePlanText(JSON.stringify(withoutSubtasks));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('subtasks');
  });
});
