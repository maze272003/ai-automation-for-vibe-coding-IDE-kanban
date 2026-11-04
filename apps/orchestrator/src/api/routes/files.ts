// apps/orchestrator/src/api/routes/files.ts
import {
  FileWriteRequest,
  MAX_FILE_BYTES,
  MAX_SEARCH_RESULTS,
  RepoRelPath,
} from '@aik/contracts';
import type { AikDb } from '@aik/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WorkspaceFileService } from '../../files/service.ts';
import type { Clock } from '../../time.ts';
import { mutation, parse } from '../idempotency.ts';
import { IdParams } from './projects.ts';

const TreeQuery = z.object({ path: z.union([z.literal(''), RepoRelPath]).optional() });
const ContentQuery = z.object({ path: RepoRelPath });
const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  // Literal strings only: `z.coerce.boolean()` would turn the string "false" into true.
  caseSensitive: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
});

export function registerFileRoutes(
  app: FastifyInstance,
  deps: { db: AikDb; now: Clock; files: WorkspaceFileService },
): void {
  const idOf = (req: { params: unknown }) => parse(IdParams, req.params).id;

  app.get('/projects/:id/files/tree', async (req) => {
    const query = parse(TreeQuery, req.query);
    return deps.files.tree(idOf(req), query.path ?? '');
  });

  app.get('/projects/:id/files/content', async (req) => {
    const query = parse(ContentQuery, req.query);
    return deps.files.read(idOf(req), query.path);
  });

  app.get('/projects/:id/files/search', async (req) => {
    const query = parse(SearchQuery, req.query);
    return deps.files.search(idOf(req), query.q, {
      ...(query.caseSensitive !== undefined ? { caseSensitive: query.caseSensitive === 'true' } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
  });

  mutation(
    app,
    deps,
    'PUT',
    '/projects/:id/files/content',
    async (req) => ({
      status: 200,
      body: await deps.files.write(idOf(req), parse(FileWriteRequest, req.body)),
    }),
    // JSON escaping can expand control characters sixfold, so the transport cap must sit well
    // above MAX_FILE_BYTES; the service still enforces the real byte limit.
    { bodyLimit: MAX_FILE_BYTES * 6 + 64 * 1024 },
  );
}
