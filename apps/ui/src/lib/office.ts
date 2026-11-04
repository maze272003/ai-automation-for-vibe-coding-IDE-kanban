// apps/ui/src/lib/office.ts — pure helpers for the embedded Pixel Agents office view.
import type { AppSettings, OfficeBounds } from '@aik/contracts';

export function isOfficeEnabled(settings: AppSettings | null): boolean {
  return settings?.agentOffice === true;
}

export function toOfficeBounds(rect: { x: number; y: number; width: number; height: number }): OfficeBounds {
  const round = (n: number) => Math.max(0, Math.round(n));
  return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) };
}

/** Office character labels are exactly `${storyKey} ${role}` (we generate the cwd); the last space separates them. */
export function parseOfficeLabel(label: string): { storyKey: string; role: string } | null {
  const trimmed = label.trim();
  const idx = trimmed.lastIndexOf(' ');
  if (idx <= 0 || idx === trimmed.length - 1) return null;
  return { storyKey: trimmed.slice(0, idx), role: trimmed.slice(idx + 1) };
}
