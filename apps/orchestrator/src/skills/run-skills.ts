import { runSkills, type AikDbOrTx } from '@aik/db';
import type { DeliveredSkill } from './bridge.ts';

export function recordRunSkills(
  db: AikDbOrTx,
  now: Date,
  agentRunId: number,
  delivered: readonly DeliveredSkill[],
): void {
  if (delivered.length === 0) return;
  db.insert(runSkills)
    .values(
      delivered.map((skill) => ({
        agentRunId,
        skillId: skill.id,
        skillName: skill.name,
        contentSha256: skill.contentSha256,
        createdAt: now,
      })),
    )
    .onConflictDoNothing()
    .run();
}
