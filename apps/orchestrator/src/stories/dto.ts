// apps/orchestrator/src/stories/dto.ts
import { BLOCKED_HINTS, type StoryDTO } from '@aik/contracts';
import { acceptanceCriteria, agentRuns, modelProfiles, plans, pullRequests, storyDependencies, userStories, type AikDbOrTx } from '@aik/db';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { StoryRow } from '../workflow/snapshot.ts';

export function toStoryDTO(db: AikDbOrTx, r: StoryRow): StoryDTO {
  const acs = db
    .select({ id: acceptanceCriteria.id, ordinal: acceptanceCriteria.ordinal, text: acceptanceCriteria.text })
    .from(acceptanceCriteria)
    .where(and(eq(acceptanceCriteria.storyId, r.id), isNull(acceptanceCriteria.supersededAt)))
    .orderBy(asc(acceptanceCriteria.ordinal))
    .all();
  const deps = db
    .select({ key: userStories.key })
    .from(storyDependencies)
    .innerJoin(userStories, eq(userStories.id, storyDependencies.dependsOnStoryId))
    .where(eq(storyDependencies.storyId, r.id))
    .orderBy(asc(userStories.id))
    .all()
    .map((d) => d.key);
  const plan = db
    .select({ version: plans.version })
    .from(plans)
    .where(and(eq(plans.storyId, r.id), inArray(plans.status, ['proposed', 'approved'])))
    .orderBy(desc(plans.version))
    .limit(1)
    .get();
  const run = r.activeRunId
    ? db
        .select({
          id: agentRuns.id,
          role: agentRuns.role,
          startedAt: agentRuns.startedAt,
          model: modelProfiles.modelId,
          opencodeSessionId: agentRuns.opencodeSessionId,
        })
        .from(agentRuns)
        .leftJoin(modelProfiles, eq(modelProfiles.id, agentRuns.modelProfileId))
        .where(eq(agentRuns.id, r.activeRunId))
        .get()
    : undefined;
  const lastRunRow = !run
    ? db
        .select({
          id: agentRuns.id,
          role: agentRuns.role,
          status: agentRuns.status,
          exitReason: agentRuns.exitReason,
          startedAt: agentRuns.startedAt,
          endedAt: agentRuns.endedAt,
          model: modelProfiles.modelId,
          opencodeSessionId: agentRuns.opencodeSessionId,
        })
        .from(agentRuns)
        .leftJoin(modelProfiles, eq(modelProfiles.id, agentRuns.modelProfileId))
        .where(eq(agentRuns.storyId, r.id))
        .orderBy(desc(agentRuns.id))
        .limit(1)
        .get()
    : undefined;
  const pr = db.select().from(pullRequests).where(eq(pullRequests.storyId, r.id)).orderBy(desc(pullRequests.id)).limit(1).get();
  return {
    id: r.id, key: r.key, projectId: r.projectId, title: r.title, description: r.description, priority: r.priority, rank: r.rank,
    labels: r.labels, complexity: r.complexity, revision: r.revision, status: r.status, statusVersion: r.statusVersion,
    planningStatus: r.planningStatus, activePlanVersion: plan?.version ?? null, hold: r.hold,
    blocked: r.blockedReason
      ? { reason: r.blockedReason, from: r.blockedFrom, detail: r.blockedDetail ?? '', hint: BLOCKED_HINTS[r.blockedReason] }
      : null,
    attempts: { used: r.attemptCount, max: r.maxAttempts },
    acceptanceCriteria: acs,
    dependsOn: deps,
    branch: r.branchName, candidateSha: r.candidateSha,
    activeRun: run
      ? {
          id: run.id,
          role: run.role,
          model: run.model || 'OpenCode',
          startedAt: run.startedAt?.getTime() ?? 0,
          opencodeSessionId: run.opencodeSessionId ?? null,
        }
      : null,
    lastRun: lastRunRow
      ? {
          id: lastRunRow.id,
          role: lastRunRow.role,
          status: lastRunRow.status,
          exitReason: lastRunRow.exitReason ?? null,
          model: lastRunRow.model || 'OpenCode',
          startedAt: lastRunRow.startedAt?.getTime() ?? 0,
          endedAt: lastRunRow.endedAt?.getTime() ?? null,
          opencodeSessionId: lastRunRow.opencodeSessionId ?? null,
        }
      : null,
    pullRequest: pr ? { number: pr.number, url: pr.url, state: pr.state } : null,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}
