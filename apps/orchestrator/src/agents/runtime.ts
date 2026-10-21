import { extractAssistantText, findSessionFailure, sessionHasCompleted, sessionIsActive, type OpenCodeMessageLike } from '@aik/contracts';
import { modelProfiles, providers, type AikDb } from '@aik/db';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function ensureModelProfile(db: AikDb, model?: ModelRef): number | null {
  if (!model?.id) return null;
  const providerName = model.providerID || 'opencode';
  try {
    let prov = db.select().from(providers).where(eq(providers.name, providerName)).get();
    if (!prov) {
      prov = db
        .insert(providers)
        .values({
          name: providerName,
          kind: 'openai_compatible',
          baseUrl: 'http://127.0.0.1:49374',
          costClass: 'local',
          dataUse: 'no_training',
          enabled: true,
        })
        .returning()
        .get();
    }
    let profile = db
      .select()
      .from(modelProfiles)
      .where(and(eq(modelProfiles.providerId, prov.id), eq(modelProfiles.modelId, model.id)))
      .get();
    if (!profile) {
      profile = db
        .insert(modelProfiles)
        .values({
          providerId: prov.id,
          modelId: model.id,
          family: providerName,
          contextLimit: 128_000,
          outputLimit: 8_192,
          enabled: true,
        })
        .returning()
        .get();
    }
    return profile?.id ?? null;
  } catch {
    return null;
  }
}

export interface OpenCodeRuntimeOptions {
  baseUrl?: string;
  password?: string;
  defaultModel?: ModelRef;
}

export interface ModelRef {
  id: string;
  providerID: string;
}

export interface RunOneShotInput {
  title?: string;
  directory: string;
  prompt: string;
  model?: ModelRef;
  timeoutMs?: number;
  onSessionCreated?: (sessionId: string, model?: ModelRef) => void | Promise<void>;
  /** Polled between activity checks; a truthy return aborts the run (EXE-13). */
  shouldStop?: () => boolean;
}

export interface RunOneShotOutput {
  ok: boolean;
  text?: string;
  error?: string;
  /** True when the run was aborted because `shouldStop()` returned true (EXE-13). */
  interrupted?: boolean;
}

/**
 * Per-role wall-clock budgets (spec §18.5). The planner and the reviewer get 20 minutes, the
 * implementer 60. A single flat budget cut real runs short: observed planner runs needed
 * 11–12 minutes and were killed by the old 10-minute default, which threw away the finished
 * plan and left the board stalled.
 */
export const ROLE_TIMEOUTS = {
  planner: 20 * 60_000,
  implementer: 60 * 60_000,
  reviewer: 20 * 60_000,
} as const;

/** Budget used when a caller does not pass a role budget. */
export const DEFAULT_TIMEOUT_MS = 20 * 60_000;

/**
 * Grace window after the prompt is admitted during which a session that is not yet listed as
 * active is still waited for. It only bounds the wait for a server that never reports anything;
 * a session that is running is detected through the terminal `idle` message.
 */
const START_GRACE_MS = 15_000;

/** Resolves running OpenCode service URL & password if not provided explicitly. */
export function resolveOpenCodeService(): { url: string; auth: string } | null {
  if (process.env.AIK_OPENCODE_BASE_URL) {
    return { url: process.env.AIK_OPENCODE_BASE_URL, auth: '' };
  }
  const stateDir = process.env.XDG_STATE_HOME || path.join(process.env.USERPROFILE ?? '', '.local', 'state');
  const svcFile = path.join(stateDir, 'opencode', 'service.json');
  if (fs.existsSync(svcFile)) {
    try {
      const svc = JSON.parse(fs.readFileSync(svcFile, 'utf8')) as { url?: string; password?: string };
      if (svc.url && svc.password) {
        return {
          url: svc.url,
          auth: `Basic ${Buffer.from(`opencode:${svc.password}`).toString('base64')}`,
        };
      }
    } catch {
      // unreadable
    }
  }
  return null;
}

/**
 * Upper bound on how long `runOneShot` keeps polling after it interrupts a session, in case the
 * server never reports the session idle (spec §18.5, EXE-13). The wait is also clamped to the
 * run's own timeout so an interrupt never outlives the caller's patience.
 */
const INTERRUPT_GRACE_MS = 10_000;

/** Best-effort human-readable detail from an OpenCode error body. */
function describeApiError(body: unknown): string {
  if (typeof body === 'string' && body.length > 0) return body;
  if (!body || typeof body !== 'object') return 'no details';
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string' && error.length > 0) return error;
  if (error && typeof error === 'object') {
    const data = (error as { data?: { message?: string } }).data;
    if (typeof data?.message === 'string' && data.message.length > 0) return data.message;
    const name = (error as { name?: string }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  const message = (body as { message?: string }).message;
  if (typeof message === 'string' && message.length > 0) return message;
  return JSON.stringify(body).slice(0, 200);
}

export class OpenCodeRuntime {
  private baseUrl?: string;
  private auth?: string;
  private defaultModel?: ModelRef;

  constructor(opts: OpenCodeRuntimeOptions = {}) {
    this.defaultModel = opts.defaultModel;
    if (opts.baseUrl) {
      this.baseUrl = opts.baseUrl;
      const pass = opts.password ?? '';
      this.auth = pass ? `Basic ${Buffer.from(`opencode:${pass}`).toString('base64')}` : '';
    }
  }

  private ensureConnected(): { baseUrl: string; auth: string } {
    if (this.baseUrl) {
      return { baseUrl: this.baseUrl, auth: this.auth ?? '' };
    }
    const resolved = resolveOpenCodeService();
    if (!resolved) {
      throw new Error('OpenCode service is not running');
    }
    this.baseUrl = resolved.url;
    this.auth = resolved.auth;
    return { baseUrl: this.baseUrl, auth: this.auth };
  }

  async resolveModel(explicit?: ModelRef, directory?: string): Promise<ModelRef | undefined> {
    if (explicit) return explicit;
    if (this.defaultModel) return this.defaultModel;
    try {
      const res = await this.api('GET', '/api/model', directory ?? process.cwd());
      const models = (res.body as { data?: ModelRef[] } | null)?.data ?? [];
      const configured = models.find((m) => m.providerID !== 'opencode' && !m.id.includes('free'));
      if (configured) {
        this.defaultModel = configured;
        return configured;
      }
      if (models.length > 0) {
        this.defaultModel = models[0];
        return models[0];
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  private async api(method: string, p: string, directory: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const conn = this.ensureConnected();
    const res = await fetch(new URL(p, conn.baseUrl), {
      method,
      headers: {
        ...(conn.auth ? { authorization: conn.auth } : {}),
        'content-type': 'application/json',
        'x-opencode-directory': directory,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }

  async runOneShot(input: RunOneShotInput): Promise<RunOneShotOutput> {
    const id = `ses_aik${crypto.randomBytes(8).toString('hex')}`;
    try {
      if (input.shouldStop?.()) {
        return { ok: false, interrupted: true, error: 'Run interrupted before it started' };
      }
      const model = await this.resolveModel(input.model, input.directory);
      const created = await this.api('POST', '/api/session', input.directory, {
        id,
        title: input.title ?? 'Story Task',
        location: { directory: input.directory },
        ...(model ? { model: { id: model.id, providerID: model.providerID } } : {}),
      });

      if (created.status !== 200) {
        return { ok: false, error: `The model refused the session (${created.status})` };
      }

      if (input.onSessionCreated) {
        try {
          await input.onSessionCreated(id, model);
        } catch {
          // ignore callback error
        }
      }

      const prompted = await this.api('POST', `/api/session/${id}/prompt`, input.directory, { text: input.prompt });
      if (prompted.status < 200 || prompted.status >= 300) {
        // A rejected prompt used to be swallowed here and surfaced later as "no text", which
        // hid the real reason (unknown session, conflict, invalid input) from the board.
        return { ok: false, error: `OpenCode rejected the prompt (${prompted.status}): ${describeApiError(prompted.body)}` };
      }

      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      // A run that is not listed as active yet must not be mistaken for a finished run: the
      // server writes a terminal `idle` message when a session ends, so that is the signal we
      // trust. The grace window only bounds the wait for a session that never reports anything.
      const startGraceDeadline = Date.now() + START_GRACE_MS;
      let interruptSent = false;
      let graceDeadline = 0;
      let sawActive = false;
      for (;;) {
        if (input.shouldStop?.() && !interruptSent) {
          // Fire the interrupt exactly once; the stop flag alone must end the loop even if the
          // server ignores the call (EXE-13).
          interruptSent = true;
          graceDeadline = Math.min(Date.now() + INTERRUPT_GRACE_MS, deadline);
          await this.interrupt(id, input.directory);
        }
        const active = await this.api('GET', '/api/session/active', input.directory).catch(() => ({ status: 0, body: null }));
        if (sessionIsActive(active.body, id)) {
          sawActive = true;
        } else if (sawActive || interruptSent) {
          // The session ran and is no longer active, or a stop was requested: it is done.
          break;
        } else {
          // The session is not listed as active (yet). The terminal `idle` message is the
          // authoritative completion signal, so confirm with the message list before ending the
          // run — a slow start must not be read as "the model already answered".
          const pending = await this.api('GET', `/api/session/${id}/message`, input.directory).catch(() => ({ status: 0, body: null }));
          const pendingMessages = (pending.body as { data?: OpenCodeMessageLike[] } | null)?.data ?? [];
          if (sessionHasCompleted(pendingMessages) || Date.now() > startGraceDeadline) break;
        }
        if (interruptSent) {
          if (Date.now() > graceDeadline) {
            return { ok: false, interrupted: true, error: 'Run interrupted by a stop request' };
          }
        } else if (Date.now() > deadline) {
          // The run overran its budget. Interrupt the session so the model stops working (and
          // billing) on a result nobody will read, then report the timeout.
          await this.interrupt(id, input.directory);
          return { ok: false, error: `The model did not finish within ${Math.round(timeoutMs / 1000)} seconds` };
        }
        await new Promise((r) => setTimeout(r, 400));
      }

      if (interruptSent) {
        return { ok: false, interrupted: true, error: 'Run interrupted by a stop request' };
      }

      const messagesRes = await this.api('GET', `/api/session/${id}/message`, input.directory);
      const data = (messagesRes.body as { data?: OpenCodeMessageLike[] } | null)?.data ?? [];

      const failure = findSessionFailure(data);
      if (failure) {
        return { ok: false, error: failure.message };
      }

      // The server returns the messages newest first, and the newest assistant message is
      // usually a tool call without any text — the answer sits in an earlier message. Taking the
      // last assistant message that carries text is what the model's final answer is.
      const text = extractAssistantText(data);

      if (!text) {
        const started = data.some((m) => m.type === 'assistant' || m.type === 'user');
        return { ok: false, error: started ? 'The model returned no text' : 'The OpenCode session did not start' };
      }

      return { ok: true, text };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Interrupts a session (spec §18.5: POST /api/session/{id}/interrupt). True on a 2xx reply. */
  async interrupt(sessionId: string, directory: string): Promise<boolean> {
    try {
      const res = await this.api('POST', `/api/session/${sessionId}/interrupt`, directory, {});
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

  async getSessionMessages(sessionId: string, directory?: string): Promise<{ ok: boolean; messages: unknown[]; error?: string }> {
    try {
      const res = await this.api('GET', `/api/session/${sessionId}/message`, directory ?? process.cwd());
      const data = (res.body as { data?: unknown[] } | null)?.data ?? (Array.isArray(res.body) ? res.body : []);
      return { ok: true, messages: data };
    } catch (e) {
      return { ok: false, messages: [], error: e instanceof Error ? e.message : String(e) };
    }
  }
}
