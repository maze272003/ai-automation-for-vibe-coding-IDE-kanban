// apps/desktop/src/main/office-context.ts — main-process memory holder for the running office
// server, mirroring gateway-context.ts. The supervisor's initMessage closure reads it at spawn
// time, so a restart after a settings toggle picks the new state up automatically.
import type { OfficeBounds, OfficeConfig } from '@aik/contracts';

let context: OfficeConfig | null = null;

export function setOfficeContext(next: OfficeConfig | null): void {
  context = next;
}

export function getOfficeContext(): OfficeConfig | null {
  return context;
}

/** Rounds/clamps a renderer-reported rect; null when the payload is not a usable rect. */
export function parseOfficeBounds(raw: unknown): OfficeBounds | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const parts = [r.x, r.y, r.width, r.height];
  if (!parts.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const round = (n: number) => Math.max(0, Math.round(n));
  return { x: round(parts[0] as number), y: round(parts[1] as number), width: round(parts[2] as number), height: round(parts[3] as number) };
}

export function clearOfficeContextForTests(): void {
  context = null;
}
