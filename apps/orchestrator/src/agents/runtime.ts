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

interface OpenCodeMessage {
  type?: string;
  outcome?: string;
  finish?: string;
  content?: { type?: string; text?: string }[];
  error?: { message?: string };
}

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

      await this.api('POST', `/api/session/${id}/prompt`, input.directory, { text: input.prompt });

      const deadline = Date.now() + (input.timeoutMs ?? 600_000);
      let interruptSent = false;
      let graceDeadline = 0;
      for (;;) {
        if (input.shouldStop?.() && !interruptSent) {
          // Fire the interrupt exactly once; the stop flag alone must end the loop even if the
          // server ignores the call (EXE-13).
          interruptSent = true;
          graceDeadline = Math.min(Date.now() + INTERRUPT_GRACE_MS, deadline);
          await this.interrupt(id, input.directory);
        }
        const active = await this.api('GET', '/api/session/active', input.directory).catch(() => ({ status: 0, body: null }));
        if (!JSON.stringify(active.body).includes(id)) {
          if (interruptSent) {
            return { ok: false, interrupted: true, error: 'Run interrupted by a stop request' };
          }
          break;
        }
        if (interruptSent) {
          if (Date.now() > graceDeadline) {
            return { ok: false, interrupted: true, error: 'Run interrupted by a stop request' };
          }
        } else if (Date.now() > deadline) {
          return { ok: false, error: 'The model did not finish within timeout' };
        }
        await new Promise((r) => setTimeout(r, 400));
      }

      const messagesRes = await this.api('GET', `/api/session/${id}/message`, input.directory);
      const data = (messagesRes.body as { data?: OpenCodeMessage[] } | null)?.data ?? [];

      const failure = data.find((m) => m.type === 'idle' && m.outcome === 'failed') ?? data.find((m) => m.finish === 'error');
      if (failure?.error?.message) {
        return { ok: false, error: failure.error.message };
      }

      const assistant = [...data].reverse().find((m) => m.type === 'assistant');
      const text = (assistant?.content ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n').trim();

      if (!text) {
        return { ok: false, error: 'The model returned no text' };
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
