import type { OfficePreferences } from '@aik/contracts';
import { memo, useMemo } from 'react';
import { Box3, Vector3 } from 'three';
import { DEV_LENGTH, LAB_LENGTH, ROOM_HEIGHT, SLOT_DEPTH } from '../layout/dimensions.ts';
import { localToRoom } from '../layout/footprints.ts';
import { paintActivity, paintKanban, paintPm, paintRuns, paintTestBoard } from '../screens/paint.ts';
import { stateColor, type SuiteModel } from './derive.ts';
import { itemScreens } from './props.ts';
import { Screen } from './Screen.tsx';
import { Sign } from './Sign.tsx';
import { INTERNAL_DOOR_Z, WALL_T } from './structure.ts';
import { itemYaw, roomToWorld, suiteFrame, type Area, type SuiteFrame } from './transform.ts';

/** Back-wall screens of the dev room (room-local x centre, width/height in m, canvas px). */
const WALL_SCREENS = {
  kanban: { x: 5, w: 4.8, h: 1.6, px: [192, 64] as [number, number] },
  activity: { x: 9.2, w: 2.2, h: 1.2, px: [72, 40] as [number, number] },
  runs: { x: 12, w: 2.6, h: 1.4, px: [104, 56] as [number, number] },
} as const;
const SCREEN_Y = 2.1;

const at = (f: SuiteFrame, area: Area, x: number, y: number, z: number): [number, number, number] => {
  const w = roomToWorld(f, area, x, z);
  return [w.x, y, w.z];
};

/**
 * Per-suite pieces that are unique to a room: entrance + QA Lab signs (and the Archived / Unavailable sign
 * when dimmed), the live back-wall screens, the PM desk screen, the QA test board, the QA status light above
 * the internal door, and a selection outline. Walls, floors, glass and props are instanced across all
 * suites (Building / VoxelInstances / StatusRings).
 */
export const Suite = memo(function Suite({ model, prefs, selected }: { model: SuiteModel; prefs: Pick<OfficePreferences, 'statusColors'>; selected: boolean }) {
  const f = useMemo(() => suiteFrame(model.suite), [model.suite]);
  const front = itemYaw(f, 0);
  const back = front; // back-wall screens face into the room, i.e. toward the glass front
  const dim = model.dim !== null;
  const bounds = useMemo(() => {
    const { dev, lab } = model.suite;
    return new Box3(
      new Vector3(Math.min(dev.x0, lab.x0), 0, Math.min(dev.z0, lab.z0)),
      new Vector3(Math.max(dev.x1, lab.x1), ROOM_HEIGHT, Math.max(dev.z1, lab.z1)),
    );
  }, [model.suite]);

  const mounts = useMemo(
    () =>
      model.layout.flatMap((item) =>
        itemScreens(item).map((m) => {
          const p = localToRoom(item, m.x, m.z);
          return { key: `${item.id}:${m.kind}`, kind: m.kind, position: at(f, item.area, p.x, m.y, p.z), yaw: itemYaw(f, item.rotationY), size: [m.w, m.h] as [number, number] };
        }),
      ),
    [model.layout, f],
  );

  const sa = model.suite.signAnchor;
  const fz = model.suite.facing;
  const signPos = (y: number): [number, number, number] => [sa.x + fz.x * 0.08, y, sa.z + fz.z * 0.08];
  const qaColor = stateColor(model.stationState.qa, prefs.statusColors);
  const wallZ = WALL_T + 0.02;

  return (
    <group>
      <Sign text={model.sign} accent={model.accent} icon={model.icon} position={signPos(3.05)} yaw={front} width={7} px={512} dim={dim} />
      <Sign text="QA LAB" accent={model.accent} position={at(f, 'lab', LAB_LENGTH / 2, 3.05, SLOT_DEPTH + 0.08)} yaw={front} width={2.4} dim={dim} />
      {model.dim && (
        <Sign
          text={model.dim === 'archived' ? 'ARCHIVED' : 'UNAVAILABLE'}
          accent={model.dim === 'archived' ? '#94a3b8' : '#f87171'}
          position={signPos(2.5)}
          yaw={front}
          width={2.6}
        />
      )}

      {model.screens.kanban && (
        <Screen data={model.kanban} paint={paintKanban} px={WALL_SCREENS.kanban.px} size={[WALL_SCREENS.kanban.w, WALL_SCREENS.kanban.h]} position={at(f, 'dev', WALL_SCREENS.kanban.x, SCREEN_Y, wallZ)} yaw={back} bounds={bounds} dim={dim} />
      )}
      {model.screens.activity && (
        <Screen data={model.activity} paint={paintActivity} px={WALL_SCREENS.activity.px} size={[WALL_SCREENS.activity.w, WALL_SCREENS.activity.h]} position={at(f, 'dev', WALL_SCREENS.activity.x, SCREEN_Y, wallZ)} yaw={back} bounds={bounds} dim={dim} />
      )}
      {model.screens.runs && (
        <Screen data={model.runs} paint={paintRuns} px={WALL_SCREENS.runs.px} size={[WALL_SCREENS.runs.w, WALL_SCREENS.runs.h]} position={at(f, 'dev', WALL_SCREENS.runs.x, SCREEN_Y, wallZ)} yaw={back} bounds={bounds} dim={dim} />
      )}
      {mounts.map((m) =>
        m.kind === 'pm' ? (
          <Screen key={m.key} data={model.pm} paint={paintPm} px={[64, 40]} size={m.size} position={m.position} yaw={m.yaw} bounds={bounds} dim={dim} />
        ) : (
          <Screen key={m.key} data={model.testBoard} paint={paintTestBoard} px={[240, 76]} size={m.size} position={m.position} yaw={m.yaw} bounds={bounds} dim={dim} />
        ),
      )}

      {/* QA status light above the internal door, visible from the dev room and the hallway. */}
      <mesh position={at(f, 'dev', DEV_LENGTH, 2.55, INTERNAL_DOOR_Z)}>
        <boxGeometry args={[0.45, 0.14, 0.45]} />
        <meshBasicMaterial color={dim ? '#475569' : qaColor} toneMapped={false} />
      </mesh>

      {selected && <SelectionOutline f={f} color={model.accent} />}
    </group>
  );
});

/** Thin accent border around the whole suite floor. */
function SelectionOutline({ f, color }: { f: SuiteFrame; color: string }) {
  const L = DEV_LENGTH + LAB_LENGTH;
  const D = SLOT_DEPTH;
  const t = 0.12;
  const edges: Array<[number, number, number, number]> = [
    [0, 0, L, t],
    [0, D - t, L, D],
    [0, 0, t, D],
    [L - t, 0, L, D],
  ];
  return (
    <group>
      {edges.map(([x0, z0, x1, z1], i) => {
        const a = roomToWorld(f, 'dev', x0, z0);
        const b = roomToWorld(f, 'dev', x1, z1);
        return (
          <mesh key={i} position={[(a.x + b.x) / 2, 0.06, (a.z + b.z) / 2]}>
            <boxGeometry args={[Math.abs(b.x - a.x), 0.04, Math.abs(b.z - a.z)]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
        );
      })}
    </group>
  );
}
