/** Normalized CLI events. Text remains untrusted until the persistence redactor runs. */
export type RuntimeEvent =
  | { kind: 'session'; ref: string }
  | { kind: 'message'; text: string }
  | { kind: 'tool-start'; id: string; name: string; parentId?: string }
  | { kind: 'tool-end'; id: string; name: string; ok: boolean; parentId?: string }
  | { kind: 'command'; id: string }
  | { kind: 'subagent'; phase: 'start' | 'end'; id: string; name: string; ok?: boolean }
  | { kind: 'usage'; inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; costUsd: number | null }
  | { kind: 'result'; text?: string; structured?: unknown; isError: boolean; subtype?: string }
  | { kind: 'denied'; tool: string; reason: string }
  | { kind: 'unknown'; type: string };
