import { memo, useMemo, useRef } from 'react';
import { Box3, Vector3 } from 'three';
import { ROOM_HEIGHT } from '../layout/dimensions.ts';
import { localToRoom } from '../layout/footprints.ts';
import { dataSignature } from '../screens/data.ts';
import { paintWhiteboard } from '../screens/paint.ts';
import { whiteboardEntries } from '../state/figures.ts';
import type { OfficeState } from '../state/model.ts';
import type { SuiteModel } from './derive.ts';
import { Screen } from './Screen.tsx';
import { itemYaw, roomToWorld, suiteFrame } from './transform.ts';

type Entries = ReturnType<typeof whiteboardEntries>;

/**
 * Board face of the audit whiteboard item (props.ts: the whiteboard model sits at item-local z = -0.15, 0.25 m
 * deep, scaled 1.3 x 1.2): the content plane covers its frame, just in front of it, facing item-local +z.
 */
const BOARD = { z: 0.01, y: 0.9, w: 2.2, h: 1.1, px: [128, 64] as [number, number] };

/** The audit whiteboard of one suite: the failed checks QA wrote up (§6.4a), repainted only when they change. */
export const Whiteboard = memo(function Whiteboard({ model, entries }: { model: SuiteModel; entries: Entries }) {
  const f = useMemo(() => suiteFrame(model.suite), [model.suite]);
  const bounds = useMemo(() => {
    const { dev, lab } = model.suite;
    return new Box3(
      new Vector3(Math.min(dev.x0, lab.x0), 0, Math.min(dev.z0, lab.z0)),
      new Vector3(Math.max(dev.x1, lab.x1), ROOM_HEIGHT, Math.max(dev.z1, lab.z1)),
    );
  }, [model.suite]);
  const boards = useMemo(
    () =>
      model.layout
        .filter((item) => item.kind === 'audit-whiteboard')
        .map((item) => {
          const p = localToRoom(item, 0, BOARD.z);
          const w = roomToWorld(f, item.area, p.x, p.z);
          return { key: item.id, position: [w.x, BOARD.y, w.z] as [number, number, number], yaw: itemYaw(f, item.rotationY) };
        }),
    [model.layout, f],
  );
  return (
    <>
      {boards.map((b) => (
        <Screen key={b.key} data={entries} paint={paintWhiteboard} px={BOARD.px} size={[BOARD.w, BOARD.h]} position={b.position} yaw={b.yaw} bounds={bounds} dim={model.dim !== null} />
      ))}
    </>
  );
});

const NONE: Entries = [];

/** Every visible suite's audit whiteboard; entry lists keep their identity while unchanged (no re-render). */
export function Whiteboards({ suites, state }: { suites: SuiteModel[]; state: OfficeState }) {
  const cache = useRef(new Map<number, { sig: string; entries: Entries }>());
  return (
    <>
      {suites.map((m) => {
        const fresh = m.dim === null ? whiteboardEntries(state, m.roomId) : NONE;
        const sig = dataSignature(fresh);
        let hit = cache.current.get(m.roomId);
        if (!hit || hit.sig !== sig) {
          hit = { sig, entries: fresh };
          cache.current.set(m.roomId, hit);
        }
        return <Whiteboard key={m.roomId} model={m} entries={hit.entries} />;
      })}
    </>
  );
}
