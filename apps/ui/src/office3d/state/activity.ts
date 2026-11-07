import type { SpotKind } from '../layout/waypoints.ts';
import type { ActivityView } from './model.ts';

export type Activity =
  | 'reading'
  | 'coding'
  | 'running'
  | 'testing-cmd'
  | 'thinking'
  | 'writing'
  | 'delegating'
  | 'tool'
  | 'qa-testing'
  | 'qa-failure'
  | 'qa-passed';

export const IDLE_THINK_MS = 8000;
export const BUBBLE_MAX = 40;

export const ACTIVITY_SPOT: Record<Activity, SpotKind> = {
  reading: 'sofa',
  coding: 'seat',
  running: 'seat',
  'testing-cmd': 'seat',
  writing: 'seat',
  tool: 'seat',
  thinking: 'coffee',
  delegating: 'huddle',
  'qa-testing': 'test-board',
  'qa-failure': 'whiteboard',
  'qa-passed': 'test-board',
};

const READING = new Set(['read', 'grep', 'glob', 'list', 'ls', 'search', 'websearch', 'webfetch', 'view']);
const CODING = new Set(['edit', 'write', 'patch', 'multiedit', 'apply_patch']);
const RUNNING = new Set(['bash', 'shell']);

/** Shortens to at most 40 chars; the trailing '…' counts toward the limit. */
export function truncateBubble(text: string): string {
  const chars = [...text];
  return chars.length <= BUBBLE_MAX ? text : `${chars.slice(0, BUBBLE_MAX - 1).join('')}…`;
}

const say = (verb: string, summary: string | undefined): string => (summary ? `${verb} ${summary}` : verb);

export function classifyActivity(
  a: ActivityView | null,
  ctx: { testCommand: string | null; idleMs: number },
): { activity: Activity; bubble: string } {
  const out = (activity: Activity, bubble: string) => ({ activity, bubble: truncateBubble(bubble) });
  if (ctx.idleMs > IDLE_THINK_MS) return out('thinking', 'Thinking…');
  if (!a) return out('tool', 'Working');
  if (a.kind === 'message') return out('writing', 'Writing');
  if (a.kind === 'subagent') return out('delegating', `Delegating to ${a.name ?? 'subagent'}`);
  const name = (a.name ?? '').toLowerCase();
  if (name === 'thinking' && a.kind === 'tool-start') return out('thinking', 'Thinking…');
  if (READING.has(name)) return out('reading', say('Reading', a.summary));
  if (CODING.has(name)) return out('coding', say('Coding', a.summary));
  if (RUNNING.has(name)) {
    if (ctx.testCommand && a.summary?.startsWith(ctx.testCommand)) return out('testing-cmd', 'Testing');
    return out('running', say('Running', a.summary));
  }
  return out('tool', `Using ${a.name ?? 'tool'}`);
}
