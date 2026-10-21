// packages/contracts/src/opencode.ts — the OpenCode version the app manages (spec §18.2).
export const OPENCODE_PIN = '2.0.32';

/**
 * The subset of an OpenCode session message that the app reads.
 *
 * `GET /api/session/{id}/message` returns the messages **newest first** (verified against the
 * pinned server), and the newest assistant message is usually a tool call with no text part.
 * Every consumer that needs the model's final answer therefore has to order the messages and
 * pick the last assistant message that actually carries text.
 */
export interface OpenCodeMessageLike {
  type?: string;
  outcome?: string;
  finish?: string;
  content?: { type?: string; text?: string }[];
  error?: { message?: string };
  time?: { created?: number };
}

/**
 * Messages in chronological order: by `time.created` when the server sent it, otherwise in the
 * order they were received.
 */
export function chronologicalMessages<T extends OpenCodeMessageLike>(messages: readonly T[]): T[] {
  const timed = messages.length > 0 && messages.every((m) => typeof m.time?.created === 'number');
  if (!timed) return [...messages];
  return [...messages].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
}

/**
 * The final assistant text of a session.
 *
 * Reading the newest assistant message alone is wrong: the model usually ends a turn with tool
 * calls (no text), while the answer sits in an earlier message. The last assistant message that
 * carries text — in chronological order — is the model's answer.
 */
export function extractAssistantText(messages: readonly OpenCodeMessageLike[]): string {
  let text = '';
  for (const message of chronologicalMessages(messages)) {
    if (message.type !== 'assistant') continue;
    const candidate = (message.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n')
      .trim();
    if (candidate) text = candidate;
  }
  return text;
}

/** The terminal failure of a session, if the server reported one. */
export function findSessionFailure(messages: readonly OpenCodeMessageLike[]): { message: string } | null {
  const failure = messages.find((m) => m.type === 'idle' && m.outcome === 'failed') ?? messages.find((m) => m.finish === 'error');
  const message = failure?.error?.message;
  return typeof message === 'string' && message.length > 0 ? { message } : null;
}

/**
 * True when the server wrote the terminal `idle` message, i.e. the session finished its run
 * (succeeded, failed or interrupted). It is the authoritative completion signal — a session
 * that is not listed as active may still be starting up.
 */
export function sessionHasCompleted(messages: readonly OpenCodeMessageLike[]): boolean {
  return messages.some((m) => m.type === 'idle');
}

/** True when the `GET /api/session/active` payload lists the given session. */
export function sessionIsActive(payload: unknown, sessionId: string): boolean {
  return JSON.stringify(payload ?? null).includes(sessionId);
}
