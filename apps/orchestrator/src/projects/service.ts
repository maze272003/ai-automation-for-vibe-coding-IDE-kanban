// apps/orchestrator/src/projects/service.ts
import { ProjectSettings, defaultProjectSettings, type CreateProjectRequest, type PatchProjectRequest, type ProjectDTO } from '@aik/contracts';
import { projects, type AikDb } from '@aik/db';
import { eq, ne } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { ApiHttpError } from '../api/errors.ts';
import { git, stripCredentials } from '../git/git.ts';
import { systemClock, type Clock } from '../time.ts';

type ProjectRow = typeof projects.$inferSelect;

const toDTO = (r: ProjectRow): ProjectDTO => ({
  id: r.id, key: r.key, name: r.name, repoPath: r.repoPath, baseBranch: r.baseBranch, remoteUrl: r.remoteUrl,
  status: r.status, settings: ProjectSettings.parse(r.settings), createdAt: r.createdAt.getTime(), updatedAt: r.updatedAt.getTime(),
});

const invalid = (message: string) => new ApiHttpError(400, 'VALIDATION_FAILED', message);
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function detectBaseBranch(root: string): Promise<string> {
  const remoteHead = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd: root }).catch(() => '');
  if (remoteHead.startsWith('origin/')) return remoteHead.slice('origin/'.length);
  const current = await git(['branch', '--show-current'], { cwd: root }).catch(() => '');
  return current || 'main';
}

export class ProjectService {
  private readonly db: AikDb;
  private readonly now: Clock;

  constructor(deps: { db: AikDb; now?: Clock }) {
    this.db = deps.db;
    this.now = deps.now ?? systemClock;
  }

  list(): ProjectDTO[] {
    return this.db.select().from(projects).where(ne(projects.status, 'archived')).orderBy(projects.name).all().map(toDTO);
  }

  get(id: number): ProjectDTO {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    if (!row) throw new ApiHttpError(404, 'NOT_FOUND', `Project ${id} not found`);
    return toDTO(row);
  }

  async create(input: CreateProjectRequest): Promise<ProjectDTO> {
    if (!path.isAbsolute(input.repoPath)) throw invalid('repoPath must be an absolute path');
    const requested = path.resolve(input.repoPath);
    if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) throw invalid(`Folder does not exist: ${requested}`);
    let top: string;
    try {
      top = await git(['rev-parse', '--show-toplevel'], { cwd: requested });
    } catch {
      throw invalid(`Folder is not inside a git repository: ${requested}`);
    }
    const root = fs.realpathSync.native(path.resolve(top));
    const existing = this.db.select().from(projects).all();
    if (existing.some((p) => p.key === input.key)) throw invalid(`Project key ${input.key} is already in use`);
    const clash = existing.find((p) => samePath(p.repoPath, root));
    if (clash) throw invalid(`This repository is already registered as ${clash.key}`);
    const baseBranch = input.baseBranch ?? (await detectBaseBranch(root));
    const remoteUrl = await git(['remote', 'get-url', 'origin'], { cwd: root }).then(stripCredentials, () => null);
    const now = new Date(this.now());
    const row = this.db
      .insert(projects)
      .values({ key: input.key, name: input.name, repoPath: root, baseBranch, remoteUrl, settings: defaultProjectSettings(), status: 'active', createdAt: now, updatedAt: now })
      .returning()
      .get();
    return toDTO(row);
  }

  patch(id: number, input: PatchProjectRequest): ProjectDTO {
    this.get(id);
    const patchValues: Partial<typeof projects.$inferInsert> = { updatedAt: new Date(this.now()) };
    if (input.name !== undefined) patchValues.name = input.name;
    if (input.baseBranch !== undefined) patchValues.baseBranch = input.baseBranch;
    if (input.settings !== undefined) patchValues.settings = input.settings;
    const row = this.db
      .update(projects)
      .set(patchValues)
      .where(eq(projects.id, id))
      .returning()
      .get();
    return toDTO(row!);
  }

  async refreshAvailability(): Promise<void> {
    for (const p of this.db.select().from(projects).where(ne(projects.status, 'archived')).all()) {
      const ok = fs.existsSync(p.repoPath) && (await git(['rev-parse', '--git-dir'], { cwd: p.repoPath }).then(() => true, () => false));
      const status = ok ? 'active' : 'unavailable';
      if (status !== p.status) this.db.update(projects).set({ status, updatedAt: new Date(this.now()) }).where(eq(projects.id, p.id)).run();
    }
  }
}
