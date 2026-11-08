// apps/ui/src/lib/plan-view.ts
import type { PlanV1, StoryDTO } from '@aik/contracts';

/** Renders a plan as the review-modal lines: header, assumptions, risks, ACs, then subtasks with their files. */
export function planToLines(plan: PlanV1): string[] {
  return [
    `Summary: ${plan.summary}`,
    `Complexity: ${plan.complexity}`,
    ...plan.assumptions.map((text) => `Assumption: ${text}`),
    ...plan.risks.map((text) => `Risk: ${text}`),
    ...plan.acceptanceCriteria.map((ac) => `AC ${ac.ref}: ${ac.text} — verify: ${ac.verification}`),
    ...plan.subtasks.flatMap((subtask) => [
      `Subtask ${subtask.id}: ${subtask.description}`,
      ...subtask.files.map((file) => `  file: ${file}`),
    ]),
  ];
}

export interface PlanLineDiff {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

/** Longest-common-subsequence line diff between two plans; removed lines precede added ones at each change point. */
export function diffPlanLines(prev: PlanV1, next: PlanV1): PlanLineDiff[] {
  const a = planToLines(prev);
  const b = planToLines(next);
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const diff: PlanLineDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      diff.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      diff.push({ kind: 'removed', text: a[i]! });
      i += 1;
    } else {
      diff.push({ kind: 'added', text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) {
    diff.push({ kind: 'removed', text: a[i]! });
    i += 1;
  }
  while (j < b.length) {
    diff.push({ kind: 'added', text: b[j]! });
    j += 1;
  }
  return diff;
}

export interface PlanBadge {
  label: string;
  tone: 'info' | 'warning';
}

/** The planning badge a NEW card shows, or null when planning needs no human attention. */
export function planBadge(story: Pick<StoryDTO, 'status' | 'planningStatus'>): PlanBadge | null {
  if (story.status !== 'NEW') return null;
  switch (story.planningStatus) {
    case 'plan_proposed':
      return { label: 'Plan ready for approval', tone: 'info' };
    case 'needs_clarification':
      return { label: 'Needs your answers', tone: 'info' };
    case 'planning_failed':
      return { label: 'Planning failed — retrying', tone: 'warning' };
    default:
      return null;
  }
}
