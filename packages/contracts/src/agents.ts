import { z } from 'zod';

export const PlanV1 = z.object({
  schemaVersion: z.literal(1),
  summary: z.string().min(1),
  assumptions: z.array(z.string()),
  clarificationQuestions: z.array(z.string()),
  acceptanceCriteria: z.array(z.object({ ref: z.string(), text: z.string(), testable: z.boolean(), verification: z.string() })),
  subtasks: z.array(z.object({ id: z.string(), description: z.string(), files: z.array(z.string()) })).min(1),
  affectedFiles: z.array(z.string()),
  requiredTests: z.array(z.string()),
  migrations: z.object({ required: z.boolean(), notes: z.string() }),
  securitySensitive: z.array(z.string()),
  dependencyChanges: z.array(z.string()),
  conflictsWith: z.array(z.string()),
  complexity: z.enum(['S', 'M', 'L', 'XL']),
  risks: z.array(z.string()),
});
export type PlanV1 = z.infer<typeof PlanV1>;

export const ReviewV1 = z.object({
  schemaVersion: z.literal(1),
  verdict: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'BLOCKED']),
  summary: z.string(),
  acChecklist: z.array(z.object({ acRef: z.string(), status: z.enum(['met', 'unmet', 'unclear']), evidence: z.string() })),
  findings: z.array(
    z.object({
      id: z.string(),
      severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
      category: z.enum([
        'correctness', 'missing_requirement', 'regression', 'security', 'validation', 'data_integrity', 'error_handling',
        'edge_case', 'tests', 'performance', 'duplication', 'dependency', 'unsafe_operation', 'other',
      ]),
      file: z.string().optional(),
      lineStart: z.number().int().optional(),
      lineEnd: z.number().int().optional(),
      evidence: z.string(),
      explanation: z.string(),
      recommendation: z.string(),
      blocking: z.boolean(),
    }),
  ),
  priorFindings: z.array(z.object({ id: z.string(), status: z.enum(['resolved', 'unresolved', 'disputed']), note: z.string() })),
  blockedReason: z.string().optional(),
});
export type ReviewV1 = z.infer<typeof ReviewV1>;
