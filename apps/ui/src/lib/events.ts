import type { EventEnvelope, SystemState } from '@aik/contracts';
import { useEffect, useRef, useState } from 'react';

/** Subscribes to orchestrator events; drops anything already seen (by seq). */
export function useOutboxEvents(onEvent: (event: EventEnvelope) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const lastSeq = useRef(0);
  useEffect(
    () =>
      window.api.events.subscribe((e) => {
        if (e.topic !== 'system.resync' && e.seq <= lastSeq.current) return;
        lastSeq.current = Math.max(lastSeq.current, e.seq);
        handler.current(e);
      }),
    [],
  );
}

export function useSystemState(): SystemState {
  const [state, setState] = useState<SystemState>({ state: 'starting', fatal: null });
  useEffect(() => {
    let alive = true;
    void window.api.systemState().then((s) => {
      if (alive) setState(s);
    });
    const off = window.api.system.subscribe(setState);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}
