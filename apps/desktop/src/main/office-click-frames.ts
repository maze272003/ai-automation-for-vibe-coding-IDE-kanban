// apps/desktop/src/main/office-click-frames.ts — pure parsing of pixel-agents WebSocket
// frames for the office click observer (spec 2026-11-04-office-agent-activity, CDP variant).
// Click: the SPA sends {type:'focusAgent', id}. Labels: agentCreated carries
// {id, directoryName}; existingAgents carries {directoryNames:{[id]:name}}; agentClosed {id}.
export type OfficeFrameMap = Map<number, string>;

/** Mutates `map` from a received broadcast frame; ignores everything else. Never throws. */
export function applyOfficeFrame(map: OfficeFrameMap, payload: unknown): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(typeof payload === 'string' ? payload : String(payload)) as Record<string, unknown>;
  } catch {
    return;
  }
  if (typeof msg !== 'object' || msg === null) return;
  if (msg.type === 'agentCreated') {
    note(map, msg.id, msg.directoryName);
  } else if (msg.type === 'agentClosed' && typeof msg.id === 'number') {
    map.delete(msg.id);
  } else if (msg.type === 'existingAgents' && typeof msg.directoryNames === 'object' && msg.directoryNames !== null) {
    for (const [id, name] of Object.entries(msg.directoryNames as Record<string, string>)) note(map, Number(id), name);
  }
}

/** The clicked character's label when `payload` is a focusAgent frame with a known id; else null. Never throws. */
export function officeClickLabel(map: OfficeFrameMap, payload: unknown): string | null {
  try {
    const msg = JSON.parse(typeof payload === 'string' ? payload : String(payload)) as Record<string, unknown>;
    if (msg?.type === 'focusAgent' && typeof msg.id === 'number') return map.get(msg.id) ?? null;
  } catch {
    // non-JSON frame
  }
  return null;
}

function note(map: OfficeFrameMap, id: unknown, name: unknown): void {
  if (typeof id === 'number' && Number.isFinite(id) && typeof name === 'string' && name !== '') map.set(id, name);
}
