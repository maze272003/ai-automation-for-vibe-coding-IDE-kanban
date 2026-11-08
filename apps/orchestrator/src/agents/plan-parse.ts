// apps/orchestrator/src/agents/plan-parse.ts
import type { PlanV1 } from '@aik/contracts';
import { z } from 'zod';

/** Result of parsing a planner answer: a validated plan, or why the text could not be used as one. */
export type ParsePlanResult = { ok: true; plan: PlanV1 } | { ok: false; error: string };

/**
 * Parses a planner answer that carries the plan as a fenced ```json block or as bare JSON.
 *
 * The planner must never have its output silently "repaired": on failure the error is the JSON
 * parse message or `z.prettifyError` of the PlanV1 validation failure, truncated to 1000 chars,
 * so the corrective turn can quote it back verbatim.
 */
export function parsePlanText(text: string): ParsePlanResult {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const jsonText = (match?.[1] ?? text).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 1000) };
  }
  const plan = PlanV1.safeParse(parsed);
  if (!plan.success) return { ok: false, error: z.prettifyError(plan.error).slice(0, 1000) };
  return { ok: true, plan: plan.data };
}
