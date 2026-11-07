import type { OfficeRoomDTO, OfficeSnapshot } from '@aik/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.ts';
import { useOutboxEvents, useSystemState } from '../../lib/events.ts';
import { emptyOfficeState, type OfficeInput, type OfficeState } from './model.ts';
import { reduceOffice } from './reduce.ts';

const SNAPSHOT_MS = 60_000;
const TICK_MS = 500;

export function useOffice(): { state: OfficeState; now: number; ready: boolean; error: string | null; refresh(): void } {
  const [state, setState] = useState<OfficeState>(emptyOfficeState);
  const [now, setNow] = useState(() => Date.now());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const sys = useSystemState();

  const feed = useCallback((input: OfficeInput) => {
    if (alive.current) setState((s) => reduceOffice(s, input, Date.now()));
  }, []);

  const loadRooms = useCallback(async () => {
    try {
      const rooms = await api.get<OfficeRoomDTO[]>('/office/rooms?include=archived');
      feed({ type: 'rooms', rooms });
      if (alive.current) {
        setError(null);
        setReady(true);
      }
      return true;
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [feed]);

  const loadSnapshot = useCallback(async () => {
    try {
      const snapshot = await api.get<OfficeSnapshot>('/office/snapshot');
      feed({ type: 'snapshot', snapshot });
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [feed]);

  const refresh = useCallback(() => {
    void Promise.all([loadRooms(), loadSnapshot()]).then(([ok]) => {
      if (alive.current && ok) setReady(true);
    });
  }, [loadRooms, loadSnapshot]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (sys.state === 'ready') refresh();
  }, [sys.state, refresh]);

  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void loadSnapshot();
    }, SNAPSHOT_MS);
    return () => clearInterval(t);
  }, [loadSnapshot]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  useOutboxEvents((event) => {
    feed({ type: 'event', event });
    if (event.topic === 'office.rooms_changed') void loadRooms();
    if (event.topic === 'system.resync') refresh();
  });

  return { state, now, ready, error, refresh };
}
