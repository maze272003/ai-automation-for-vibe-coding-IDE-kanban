# OpenCode & Skill Vault Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dynamically inject role-appropriate, human-approved skills from `@aik/skill-vault` into `.opencode/skills/` during autonomous agent execution (Planner, Implementer, Reviewer), keeping worktrees clean via Git exclusions.

**Architecture:** A new `SkillBridgeService` in `apps/orchestrator` coordinates with `@aik/skill-vault` to select approved skills, write them into target directories with vault markers, configure `.git/info/exclude` in git worktrees, and append prompt guidance.

**Tech Stack:** TypeScript, Node.js (native ESM), `@aik/skill-vault`, `better-sqlite3`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-10-19-opencode-skill-vault-integration-design.md`

## Global Constraints

- Dependencies use exact versions only (`npm install -E`). `npm run check:pins` enforces this.
- Before claiming a task is done, run: `npm run check:pins && npm run lint && npm run typecheck && npm test`.
- Tests must never operate on a real repository. Use `apps/orchestrator/test/helpers/temp.ts`, which asserts paths are under the OS temp directory.
- Never log or persist secrets. Persisted process/provider output always goes through the redactor.
- Story status changes only through `WorkflowService` — never `UPDATE user_stories SET status` directly.
- Code under `spikes/` is throwaway; never import it.

---

### Task 1: Add `@aik/skill-vault` Dependency and Build `SkillBridgeService`

**Files:**
- Modify: `apps/orchestrator/package.json`
- Create: `apps/orchestrator/src/skills/bridge.ts`
- Test: `apps/orchestrator/test/skills-bridge.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export type AgentRole = 'planner' | 'implementer' | 'reviewer';
  export interface InjectSkillsInput {
    targetDirectory: string;
    role: AgentRole;
    storyTitle: string;
    storyDescription?: string;
    repoPath: string;
    isWorktree?: boolean;
  }
  export interface InjectedSkillSummary {
    id: string;
    name: string;
    installName: string;
  }
  export interface InjectSkillsResult {
    injected: InjectedSkillSummary[];
    promptHint: string;
  }
  export class SkillBridgeService {
    constructor(deps?: { vaultRoot?: string; logger?: (msg: string) => void });
    injectSkills(input: InjectSkillsInput): Promise<InjectSkillsResult>;
    cleanupSkills(targetDirectory: string): Promise<void>;
  }
  ```

- [ ] **Step 1: Update `apps/orchestrator/package.json` to include `@aik/skill-vault`**

Add `"@aik/skill-vault": "0.1.0"` to dependencies in `apps/orchestrator/package.json`.

- [ ] **Step 2: Write failing unit tests for `SkillBridgeService`**

Create `apps/orchestrator/test/skills-bridge.test.ts`:
```typescript
import { describe, expect, test } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createTempRepo } from './helpers/temp.ts';
import { SkillBridgeService } from '../src/skills/bridge.ts';

describe('SkillBridgeService', () => {
  test('gracefully degrades when vault root does not exist', async () => {
    const temp = await createTempRepo();
    try {
      const bridge = new SkillBridgeService({ vaultRoot: path.join(temp.dir, 'non-existent-vault') });
      const result = await bridge.injectSkills({
        targetDirectory: temp.dir,
        role: 'implementer',
        storyTitle: 'Test Story',
        repoPath: temp.dir,
        isWorktree: true,
      });
      expect(result.injected).toEqual([]);
      expect(result.promptHint).toBe('');
    } finally {
      await temp.cleanup();
    }
  });

  test('configures .git/info/exclude in worktree directory', async () => {
    const temp = await createTempRepo();
    try {
      const bridge = new SkillBridgeService({ vaultRoot: path.join(temp.dir, 'non-existent-vault') });
      await bridge.injectSkills({
        targetDirectory: temp.dir,
        role: 'implementer',
        storyTitle: 'Test Story',
        repoPath: temp.dir,
        isWorktree: true,
      });

      const excludePath = path.join(temp.dir, '.git', 'info', 'exclude');
      const exists = await fsp.stat(excludePath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
      const content = await fsp.readFile(excludePath, 'utf8');
      expect(content).toContain('.opencode/');
    } finally {
      await temp.cleanup();
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/skills-bridge.test.ts`
Expected: FAIL (Cannot find module `../src/skills/bridge.ts`)

- [ ] **Step 4: Implement `SkillBridgeService`**

Create `apps/orchestrator/src/skills/bridge.ts`:
```typescript
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  VaultDb,
  defaultVaultRoot,
  installSkills,
  type SkillRow,
  type VaultPaths,
  vaultPaths,
} from '@aik/skill-vault';

export type AgentRole = 'planner' | 'implementer' | 'reviewer';

export interface InjectSkillsInput {
  targetDirectory: string;
  role: AgentRole;
  storyTitle: string;
  storyDescription?: string;
  repoPath: string;
  isWorktree?: boolean;
}

export interface InjectedSkillSummary {
  id: string;
  name: string;
  installName: string;
}

export interface InjectSkillsResult {
  injected: InjectedSkillSummary[];
  promptHint: string;
}

const ROLE_DEFAULT_SKILLS: Record<AgentRole, string[]> = {
  planner: ['writing-plans'],
  implementer: ['tdd', 'systematic-debugging'],
  reviewer: ['code-review', 'requesting-code-review'],
};

export class SkillBridgeService {
  private readonly vaultRoot?: string;
  private readonly logger?: (msg: string) => void;

  constructor(deps: { vaultRoot?: string; logger?: (msg: string) => void } = {}) {
    this.vaultRoot = deps.vaultRoot;
    this.logger = deps.logger;
  }

  private resolvePaths(): VaultPaths | null {
    try {
      const root = this.vaultRoot ?? defaultVaultRoot();
      return vaultPaths(root);
    } catch {
      return null;
    }
  }

  private async ensureGitExclude(targetDir: string): Promise<void> {
    try {
      const gitDir = path.join(targetDir, '.git');
      const gitStat = await fsp.stat(gitDir).catch(() => null);
      if (!gitStat) return;

      let excludePath: string;
      if (gitStat.isDirectory()) {
        excludePath = path.join(gitDir, 'info', 'exclude');
      } else {
        // In a git worktree, .git is a file containing "gitdir: <path>"
        const content = await fsp.readFile(gitDir, 'utf8');
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (!match) return;
        const actualGitDir = path.resolve(targetDir, match[1].trim());
        excludePath = path.join(actualGitDir, 'info', 'exclude');
      }

      await fsp.mkdir(path.dirname(excludePath), { recursive: true });
      const current = await fsp.readFile(excludePath, 'utf8').catch(() => '');
      if (!current.includes('.opencode/')) {
        await fsp.writeFile(excludePath, `${current ? current.trimEnd() + '\n' : ''}.opencode/\n`, 'utf8');
      }
    } catch (err) {
      this.logger?.(`Could not configure .git/info/exclude: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async injectSkills(input: InjectSkillsInput): Promise<InjectSkillsResult> {
    if (input.isWorktree) {
      await this.ensureGitExclude(input.targetDirectory);
    }

    const paths = this.resolvePaths();
    if (!paths) return { injected: [], promptHint: '' };

    const sqlitePath = paths.metadataDb;
    const exists = await fsp.stat(sqlitePath).then(() => true).catch(() => false);
    if (!exists) return { injected: [], promptHint: '' };

    let db: VaultDb | null = null;
    try {
      db = new VaultDb(sqlitePath);
      const wantedNames = ROLE_DEFAULT_SKILLS[input.role] ?? [];
      const placeholders = wantedNames.map(() => '?').join(',');
      const rows = wantedNames.length > 0
        ? (db.db.prepare(
            `SELECT * FROM skills WHERE status = 'approved' AND name IN (${placeholders}) LIMIT 3`,
          ).all(...wantedNames) as SkillRow[])
        : [];

      if (rows.length === 0) {
        return { injected: [], promptHint: '' };
      }

      const report = await installSkills(
        { db, paths, logger: { log: () => {} } as never },
        {
          agent: 'opencode',
          scope: 'project',
          targetRoot: input.targetDirectory,
          skills: rows,
          dryRun: false,
        },
      );

      const injected: InjectedSkillSummary[] = [];
      for (const outcome of report.outcomes) {
        if (outcome.outcome === 'installed') {
          const row = rows.find((r) => r.id === outcome.skillId);
          if (row) {
            injected.push({
              id: row.id,
              name: row.name,
              installName: path.basename(outcome.target),
            });
          }
        }
      }

      if (injected.length === 0) {
        return { injected: [], promptHint: '' };
      }

      const promptHint = [
        'AVAILABLE SKILLS (consult when applicable in .opencode/skills/):',
        ...injected.map((s) => `- ${s.installName}`),
      ].join('\n');

      return { injected, promptHint };
    } catch (err) {
      this.logger?.(`Skill injection failed: ${err instanceof Error ? err.message : String(err)}`);
      return { injected: [], promptHint: '' };
    } finally {
      db?.close();
    }
  }

  async cleanupSkills(targetDirectory: string): Promise<void> {
    try {
      const skillsDir = path.join(targetDirectory, '.opencode', 'skills');
      const entries = await fsp.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const sub = path.join(skillsDir, entry.name);
        const markerPath = path.join(sub, 'skill-vault.json');
        const hasMarker = await fsp.stat(markerPath).then(() => true).catch(() => false);
        if (hasMarker) {
          await fsp.rm(sub, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch {
      // non-fatal cleanup
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/orchestrator/test/skills-bridge.test.ts`
Expected: PASS

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/orchestrator/package.json apps/orchestrator/src/skills/bridge.ts apps/orchestrator/test/skills-bridge.test.ts
git commit -m "feat(orchestrator): add SkillBridgeService for dynamic skill injection"
```

---

### Task 2: Wire `SkillBridgeService` into `PlannerAgent`

**Files:**
- Modify: `apps/orchestrator/src/agents/planner.ts`
- Test: `apps/orchestrator/test/planner.test.ts`

**Interfaces:**
- Consumes: `SkillBridgeService` from `../skills/bridge.ts`
- PlannerAgentDeps: adds optional `skills?: SkillBridgeService`

- [ ] **Step 1: Write test verifying PlannerAgent uses SkillBridgeService**

Add a test case in `apps/orchestrator/test/planner.test.ts` checking that `injectSkills` is called with role `'planner'` and cleaned up after execution.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/planner.test.ts`
Expected: FAIL

- [ ] **Step 3: Modify `PlannerAgent` to inject and cleanup skills**

In `apps/orchestrator/src/agents/planner.ts`:
1. Import `SkillBridgeService` from `../skills/bridge.ts`.
2. Add `skills?: SkillBridgeService` to `PlannerAgentDeps`.
3. In `planStory()`:
   ```typescript
   let skillPromptHint = '';
   if (this.skills) {
     const injection = await this.skills.injectSkills({
       targetDirectory: project.repoPath,
       role: 'planner',
       storyTitle: story.title,
       storyDescription: story.description ?? undefined,
       repoPath: project.repoPath,
       isWorktree: false,
     });
     skillPromptHint = injection.promptHint ? `\n${injection.promptHint}\n` : '';
   }
   ```
4. Include `${skillPromptHint}` in `prompt`.
5. In `finally`:
   ```typescript
   if (this.skills) {
     await this.skills.cleanupSkills(project.repoPath);
   }
   ```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/planner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/orchestrator/src/agents/planner.ts apps/orchestrator/test/planner.test.ts
git commit -m "feat(orchestrator): integrate SkillBridgeService into PlannerAgent"
```

---

### Task 3: Wire `SkillBridgeService` into `ImplementerAgent`

**Files:**
- Modify: `apps/orchestrator/src/agents/implementer.ts`
- Test: `apps/orchestrator/test/implementer.test.ts`

**Interfaces:**
- Consumes: `SkillBridgeService` from `../skills/bridge.ts`
- ImplementerAgentDeps: adds optional `skills?: SkillBridgeService`

- [ ] **Step 1: Write test verifying ImplementerAgent injects skills into worktree and protects git status**

Add a test case in `apps/orchestrator/test/implementer.test.ts` verifying that `SkillBridgeService.injectSkills` is invoked with `role: 'implementer'`, `isWorktree: true`, and that `.opencode/` is never committed into the candidate sha.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/implementer.test.ts`
Expected: FAIL

- [ ] **Step 3: Modify `ImplementerAgent`**

In `apps/orchestrator/src/agents/implementer.ts`:
1. Import `SkillBridgeService` from `../skills/bridge.ts`.
2. Add `skills?: SkillBridgeService` to `ImplementerAgentDeps`.
3. In `implementStory()`:
   After preparing the worktree:
   ```typescript
   let skillPromptHint = '';
   if (this.skills) {
     const injection = await this.skills.injectSkills({
       targetDirectory: worktreePath,
       role: 'implementer',
       storyTitle: story.title,
       storyDescription: story.description ?? undefined,
       repoPath: project.repoPath,
       isWorktree: true,
     });
     skillPromptHint = injection.promptHint ? `\n${injection.promptHint}\n` : '';
   }
   ```
4. Include `${skillPromptHint}` in `buildPrompt()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/implementer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Task 3**

```bash
git add apps/orchestrator/src/agents/implementer.ts apps/orchestrator/test/implementer.test.ts
git commit -m "feat(orchestrator): integrate SkillBridgeService into ImplementerAgent"
```

---

### Task 4: Wire `SkillBridgeService` into `ReviewerAgent`

**Files:**
- Modify: `apps/orchestrator/src/agents/reviewer.ts`
- Test: `apps/orchestrator/test/reviewer.test.ts`

**Interfaces:**
- Consumes: `SkillBridgeService` from `../skills/bridge.ts`
- ReviewerAgentDeps: adds optional `skills?: SkillBridgeService`

- [ ] **Step 1: Write test verifying ReviewerAgent injects skills into review worktree**

Add a test in `apps/orchestrator/test/reviewer.test.ts` asserting that `injectSkills` is called with `role: 'reviewer'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/orchestrator/test/reviewer.test.ts`
Expected: FAIL

- [ ] **Step 3: Modify `ReviewerAgent`**

In `apps/orchestrator/src/agents/reviewer.ts`:
1. Import `SkillBridgeService` from `../skills/bridge.ts`.
2. Add `skills?: SkillBridgeService` to `ReviewerAgentDeps`.
3. In `reviewStory()`, after worktree preparation:
   ```typescript
   let skillPromptHint = '';
   if (this.skills) {
     const injection = await this.skills.injectSkills({
       targetDirectory: worktreePath,
       role: 'reviewer',
       storyTitle: story.title,
       storyDescription: story.description ?? undefined,
       repoPath: project.repoPath,
       isWorktree: true,
     });
     skillPromptHint = injection.promptHint ? `\n${injection.promptHint}\n` : '';
   }
   ```
4. Include `${skillPromptHint}` in `buildPrompt()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/orchestrator/test/reviewer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Task 4**

```bash
git add apps/orchestrator/src/agents/reviewer.ts apps/orchestrator/test/reviewer.test.ts
git commit -m "feat(orchestrator): integrate SkillBridgeService into ReviewerAgent"
```

---

### Task 5: Instantiate `SkillBridgeService` in `app.ts` & Full Verification

**Files:**
- Modify: `apps/orchestrator/src/app.ts`

- [ ] **Step 1: Instantiate and pass `SkillBridgeService` in `apps/orchestrator/src/app.ts`**

In `startOrchestrator`:
```typescript
import { SkillBridgeService } from './skills/bridge.ts';
...
const skills = new SkillBridgeService();
const planner = new PlannerAgent({ db, workflow, bus, runtime, interrupts, skills });
const implementer = new ImplementerAgent({ db, workflow, bus, runtime, worktreeManager, interrupts, skills });
const reviewer = new ReviewerAgent({ db, workflow, bus, runtime, worktreeManager, interrupts, skills });
```

- [ ] **Step 2: Run full verification suite**

Run:
```bash
npm run check:pins
npm run lint
npm run typecheck
npm test
```
Expected: All checks pass cleanly with 0 errors.

- [ ] **Step 3: Commit Task 5**

```bash
git add apps/orchestrator/src/app.ts
git commit -m "feat(orchestrator): enable SkillBridgeService across agent runner lifecycle"
```
