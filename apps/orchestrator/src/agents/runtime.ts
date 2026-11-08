import { extractAssistantText, extractSessionUsage, findSessionFailure, sessionHasCompleted, sessionIsActive, type OpenCodeMessageLike, type SessionUsage } from '@aik/contracts';
import { modelProfiles, providers, type AikDb } from '@aik/db';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createActivityDiffState, diffActivity, type RunActivityEvent } from './run-activity.ts';

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
  /** Fired at most once per 400 ms tick with the run's new activity (3D office bubbles). Never throws. */
  onActivity?: (events: RunActivityEvent[]) => void;
  /** Polled between activity checks; a truthy return aborts the run (EXE-13). */
  shouldStop?: () => boolean;
}

export interface ContinueSessionInput {
  sessionId: string;
  directory: string;
  prompt: string;
  timeoutMs: number;
  onActivity?: (events: RunActivityEvent[]) => void;
  /** Polled between activity checks; a truthy return aborts the run (EXE-13). */
  shouldStop?: () => boolean;
}

export interface RunOneShotOutput {
  ok: boolean;
  text?: string;
  error?: string;
  /** True when the run was aborted because `shouldStop()` returned true (EXE-13). */
  interrupted?: boolean;
  /** True when the run overran its wall-clock budget and was interrupted (W0-1/W0-7). */
  timedOut?: boolean;
  /** The OpenCode session the turn ran in, whenever one existed. */
  sessionId?: string;
  /** The model the session used, whenever it was resolved. */
  model?: ModelRef;
  /** Usage over the WHOLE session (cumulative across turns); null when no usage could be read. */
  usage?: SessionUsage | null;
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
      const svc = JSON.parse(fs.readFileSync(svcFile, 'utf-8')) as { url?: string; password?: string };
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

/**
 * Identifies a message across polls: its server `id` when present, else its position counted
 * from the OLDEST end (the list is newest-first, so that position is stable as new messages
 * are prepended).
 */
function messageKey(message: OpenCodeMessageLike, indexFromNewest: number, total: number): string {
  const id = (message as { id?: unknown }).id;
  if (typeof id === 'string' && id.length > 0) return id;
  return `#${total - 1 - indexFromNewest}`;
}

/** The identities of every message in a snapshot (the baseline of a previous turn). */
function baselineKeys(messages: readonly OpenCodeMessageLike[]): Set<string> {
  return new Set(messages.map((m, i) => messageKey(m, i, messages.length)));
}

/** Only the messages that are not in the baseline — what THIS turn produced (W0-3 turn horizon). */
function messagesAfter(messages: readonly OpenCodeMessageLike[], baseline: ReadonlySet<string>): OpenCodeMessageLike[] {
  return messages.filter((m, i) => !baseline.has(messageKey(m, i, messages.length)));
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

  /** Best-effort message snapshot; an unreachable server yields an empty list (usage: null). */
  private async snapshot(sessionId: string, directory: string): Promise<OpenCodeMessageLike[]> {
    try {
      const res = await this.api('GET', `/api/session/${sessionId}/message`, directory);
      return (res.body as { data?: OpenCodeMessageLike[] } | null)?.data ?? [];
    } catch {
      return [];
    }
  }

  async runOneShot(input: RunOneShotInput): Promise<RunOneShotOutput> {
    const id = `ses_aik${crypto.randomBytes(8).toString('hex')}`;
    let model: ModelRef | undefined;
    let sessionCreated = false;
    try {
      if (input.shouldStop?.()) {
        return { ok: false, interrupted: true, error: 'Run interrupted before it started' };
      }
      model = await this.resolveModel(input.model, input.directory);
      const created = await this.api('POST', '/api/session', input.directory, {
        id,
        title: input.title ?? 'Story Task',
        location: { directory: input.directory },
        ...(model ? { model: { id: model.id, providerID: model.providerID } } : {}),
      });

      if (created.status !== 200) {
        return { ok: false, error: `The model refused the session (${created.status})` };
      }
      sessionCreated = true;

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
        const messages = await this.snapshot(id, input.directory);
        return {
          ok: false,
          error: `OpenCode rejected the prompt (${prompted.status}): ${describeApiError(prompted.body)}`,
          sessionId: id,
          ...(model ? { model } : {}),
          usage: extractSessionUsage(messages),
        };
      }

      return await this.driveTurn({
        id,
        directory: input.directory,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        model,
        shouldStop: input.shouldStop,
        onActivity: input.onActivity,
        activity: input.onActivity ? createActivityDiffState() : null,
        baseline: new Set<string>(),
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (!sessionCreated) return { ok: false, error };
      const messages = await this.snapshot(id, input.directory);
      return { ok: false, error, sessionId: id, ...(model ? { model } : {}), usage: extractSessionUsage(messages) };
    }
  }

  /**
   * Adds one more turn to an existing session (W0-3 corrective turn). The messages the session
   * already holds form the baseline: completion, failure and the answer text consider only what
   * the NEW turn produces, while `usage` stays cumulative over the whole session.
   */
  async continueSession(input: ContinueSessionInput): Promise<RunOneShotOutput> {
    try {
      const baselineRes = await this.api('GET', `/api/session/${input.sessionId}/message`, input.directory).catch(() => ({ status: 0, body: null }));
      const baselineMessages = (baselineRes.body as { data?: OpenCodeMessageLike[] } | null)?.data ?? [];
      const baseline = baselineKeys(baselineMessages);
      const activity = input.onActivity ? createActivityDiffState() : null;
      if (activity) {
        // Seed the diff state with the baseline so turn 1's tool parts are never re-emitted.
        diffActivity(activity, baselineMessages);
      }

      const prompted = await this.api('POST', `/api/session/${input.sessionId}/prompt`, input.directory, { text: input.prompt });
      if (prompted.status < 200 || prompted.status >= 300) {
        const messages = await this.snapshot(input.sessionId, input.directory);
        return {
          ok: false,
          error: `OpenCode rejected the prompt (${prompted.status}): ${describeApiError(prompted.body)}`,
          sessionId: input.sessionId,
          usage: extractSessionUsage(messages),
        };
      }

      return await this.driveTurn({
        id: input.sessionId,
        directory: input.directory,
        timeoutMs: input.timeoutMs,
        model: undefined,
        shouldStop: input.shouldStop,
        onActivity: input.onActivity,
        activity,
        baseline,
      });
    } catch (e) {
      const messages = await this.snapshot(input.sessionId, input.directory);
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        sessionId: input.sessionId,
        usage: extractSessionUsage(messages),
      };
    }
  }

  /**
   * The shared poll-until-done loop of `runOneShot` and `continueSession`. Completion (`idle`
   * on a message past the baseline), failure detection, answer extraction and timeouts all
   * consider only the current turn's messages; `usage` is read from the whole session.
   */
  private async driveTurn(opts: {
    id: string;
    directory: string;
    timeoutMs: number;
    model?: ModelRef;
    shouldStop?: () => boolean;
    onActivity?: (events: RunActivityEvent[]) => void;
    activity: ReturnType<typeof createActivityDiffState> | null;
    baseline: ReadonlySet<string>;
  }): Promise<RunOneShotOutput> {
    const { id, directory, model } = opts;
    try {
      const decorate = async (partial: { ok: boolean; text?: string; error?: string; interrupted?: boolean; timedOut?: boolean }): Promise<RunOneShotOutput> => {
        const messages = await this.snapshot(id, directory);
        return {
          ...partial,
          sessionId: id,
          ...(model ? { model } : {}),
          usage: extractSessionUsage(messages),
        };
      };

      const timeoutMs = opts.timeoutMs;
      const deadline = Date.now() + timeoutMs;
      // A run that is not listed as active yet must not be mistaken for a finished run: the
      // server writes a terminal `idle` message when a session ends, so that is the signal we
      // trust. The grace window only bounds the wait for a session that never reports anything.
      const startGraceDeadline = Date.now() + START_GRACE_MS;
      let interruptSent = false;
      let graceDeadline = 0;
      let sawActive = false;
      for (;;) {
        if (opts.shouldStop?.() && !interruptSent) {
          // Fire the interrupt exactly once; the stop flag alone must end the loop even if the
          // server ignores the call (EXE-13).
          interruptSent = true;
          graceDeadline = Math.min(Date.now() + INTERRUPT_GRACE_MS, deadline);
          await this.interrupt(id, directory);
        }
        const active = await this.api('GET', '/api/session/active', directory).catch(() => ({ status: 0, body: null }));
        if (sessionIsActive(active.body, id)) {
          sawActive = true;
        } else if (sawActive || interruptSent) {
          // The session ran and is no longer active, or a stop was requested: it is done.
          break;
        } else {
          // The session is not listed as active (yet). The terminal `idle` message is the
          // authoritative completion signal, so confirm with the message list before ending the
          // run — a slow start must not be read as "the model already answered". A resumed
          // session still holds turn 1's `idle`, so only messages past the baseline count.
          const pending = await this.snapshot(id, directory);
          if (sessionHasCompleted(messagesAfter(pending, opts.baseline)) || Date.now() > startGraceDeadline) break;
        }
        if (opts.activity && opts.onActivity) {
          const res = await this.api('GET', `/api/session/${id}/message`, directory).catch(() => ({ status: 0, body: null }));
          const msgs = (res.body as { data?: unknown[] } | null)?.data ?? [];
          const events = diffActivity(opts.activity, msgs);
          if (events.length > 0) {
            try {
              opts.onActivity(events);
            } catch {
              // activity reporting must never fail a run
            }
          }
        }
        if (interruptSent) {
          if (Date.now() > graceDeadline) {
            return await decorate({ ok: false, interrupted: true, error: 'Run interrupted by a stop request' });
          }
        } else if (Date.now() > deadline) {
          // The run overran its budget. Interrupt the session so the model stops working (and
          // billing) on a result nobody will read, then report the timeout.
          await this.interrupt(id, directory);
          return await decorate({ ok: false, timedOut: true, error: `The model did not finish within ${Math.round(timeoutMs / 1000)} seconds` });
        }
        await new Promise((r) => setTimeout(r, 400));
      }

      if (interruptSent) {
        return await decorate({ ok: false, interrupted: true, error: 'Run interrupted by a stop request' });
      }

      const data = await this.snapshot(id, directory);
      const fresh = messagesAfter(data, opts.baseline);
      const tail = { sessionId: id, ...(model ? { model } : {}), usage: extractSessionUsage(data) };

      const failure = findSessionFailure(fresh);
      if (failure) {
        return { ok: false, error: failure.message, ...tail };
      }

      // The server returns the messages newest first, and the newest assistant message is
      // usually a tool call without any text — the answer sits in an earlier message. Taking the
      // last assistant message that carries text is what the model's final answer is.
      const text = extractAssistantText(fresh);

      if (!text) {
        const started = data.some((m) => m.type === 'assistant' || m.type === 'user');
        return { ok: false, error: started ? 'The model returned no text' : 'The OpenCode session did not start', ...tail };
      }

      return { ok: true, text, ...tail };
    } catch (e) {
      const messages = await this.snapshot(id, directory);
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        sessionId: id,
        ...(model ? { model } : {}),
        usage: extractSessionUsage(messages),
      };
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
