import type { OfficePreferences } from '@aik/contracts';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { memo, useEffect, useMemo } from 'react';
import { Box3, Path, Shape, Vector2, Vector3 } from 'three';
import { DEV_LENGTH, LAB_LENGTH, ROOM_HEIGHT, SLOT_DEPTH } from '../layout/dimensions.ts';
import { localToRoom } from '../layout/footprints.ts';
import { paintActivity, paintBadge, paintKanban, paintPm, paintRuns, paintTestBoard } from '../screens/paint.ts';
import { overflowBadges, roomTint, stateColor, type SuiteModel } from './derive.ts';
import { pixelCanvasTexture } from './materials.ts';
import { itemScreens, pmDeskHitBox } from './props.ts';
import { Screen } from './Screen.tsx';
import { Sign } from './Sign.tsx';
import { INTERNAL_DOOR_Z, WALL_T } from './structure.ts';
import { itemYaw, roomRectToWorld, roomToWorld, suiteFrame, type Area, type SuiteFrame } from './transform.ts';

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
 * Per-suite pieces that are unique to a room: entrance (with the project key) + QA Lab signs (and the
 * Archived / Unavailable sign when dimmed), the live back-wall screens (the Kanban screen opens the board),
 * the PM desk screen + desk click target (board), the QA test board, the QA status light above the internal
 * door, "+N" overflow badges, the aggregate-state tint and a selection outline. Walls, floors, glass and
 * props are instanced across all suites (Building / VoxelInstances / StatusRings).
 */
export const Suite = memo(function Suite({ model, prefs, selected, onOpenBoard }: {
  model: SuiteModel;
  prefs: Pick<OfficePreferences, 'statusColors'>;
  selected: boolean;
  /** Navigate to the room's project board (spec 6.6: Kanban screen, PM desk). */
  onOpenBoard?: (roomId: number) => void;
}) {
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

  const pmDesks = useMemo(
    () =>
      model.layout.flatMap((item) => {
        const hb = pmDeskHitBox(item);
        if (!hb) return [];
        const p = localToRoom(item, hb.x, hb.z);
        return [{ key: item.id, position: at(f, item.area, p.x, hb.h / 2, p.z), yaw: itemYaw(f, item.rotationY), size: [hb.w, hb.h, hb.d] as [number, number, number] }];
      }),
    [model.layout, f],
  );
  const badges = useMemo(() => overflowBadges(model), [model]);
  const tint = roomTint(model, prefs.statusColors);
  const openBoard = onOpenBoard && !dim ? () => onOpenBoard(model.roomId) : undefined;
  const onDeskClick = (e: ThreeEvent<MouseEvent>) => {
    if (!openBoard || e.delta > 4) return;
    e.stopPropagation();
    openBoard();
  };

  const sa = model.suite.signAnchor;
  const fz = model.suite.facing;
  const signPos = (y: number): [number, number, number] => [sa.x + fz.x * 0.08, y, sa.z + fz.z * 0.08];
  const qaColor = stateColor(model.stationState.qa, prefs.statusColors);
  const wallZ = WALL_T + 0.02;

  return (
    <group>
      <Sign text={model.sign} tag={model.projectKey} accent={model.accent} icon={model.icon} position={signPos(3.05)} yaw={front} width={7} px={512} dim={dim} />
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
        <Screen data={model.kanban} paint={paintKanban} px={WALL_SCREENS.kanban.px} size={[WALL_SCREENS.kanban.w, WALL_SCREENS.kanban.h]} position={at(f, 'dev', WALL_SCREENS.kanban.x, SCREEN_Y, wallZ)} yaw={back} bounds={bounds} dim={dim} onClick={openBoard} />
      )}
      {model.screens.activity && (
        <Screen data={model.activity} paint={paintActivity} px={WALL_SCREENS.activity.px} size={[WALL_SCREENS.activity.w, WALL_SCREENS.activity.h]} position={at(f, 'dev', WALL_SCREENS.activity.x, SCREEN_Y, wallZ)} yaw={back} bounds={bounds} dim={dim} />
      )}
      {model.screens.runs && (
        <Screen data={model.runs} paint={paintRuns} px={WALL_SCREENS.runs.px} size={[WALL_SCREENS.runs.w, WALL_SCREENS.runs.h]} position={at(f, 'dev', WALL_SCREENS.runs.x, SCREEN_Y, wallZ)} yaw={back} bounds={bounds} dim={dim} />
      )}
      {mounts.map((m) =>
        m.kind === 'pm' ? (
          <Screen key={m.key} data={model.pm} paint={paintPm} px={[64, 40]} size={m.size} position={m.position} yaw={m.yaw} bounds={bounds} dim={dim} onClick={openBoard} />
        ) : (
          <Screen key={m.key} data={model.testBoard} paint={paintTestBoard} px={[240, 76]} size={m.size} position={m.position} yaw={m.yaw} bounds={bounds} dim={dim} />
        ),
      )}

      {/* QA status light above the internal door, visible from the dev room and the hallway. */}
      <mesh position={at(f, 'dev', DEV_LENGTH, 2.55, INTERNAL_DOOR_Z)}>
        <boxGeometry args={[0.45, 0.14, 0.45]} />
        <meshBasicMaterial color={dim ? '#475569' : qaColor} toneMapped={false} />
      </mesh>

      {/* Invisible click target over the PM desk (the desk itself is an instanced voxel model). */}
      {openBoard &&
        pmDesks.map((d) => (
          <mesh key={d.key} position={d.position} rotation={[0, d.yaw, 0]} onClick={onDeskClick}>
            <boxGeometry args={d.size} />
            <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
          </mesh>
        ))}

      {badges.map((b) => (
        <OverflowBadge key={b.key} text={b.text} position={[b.x, b.y, b.z]} />
      ))}

      {tint?.wash && <FloorWash f={f} color={tint.wash} />}
      {selected ? <SelectionOutline f={f} color={model.accent} /> : tint && <SelectionOutline f={f} color={tint.outline} y={0.05} />}
    </group>
  );
});

/** Camera-facing "+N" badge above the last seat of an overflowing station (one small CanvasTexture). */
function OverflowBadge({ text, position }: { text: string; position: [number, number, number] }) {
  const { ctx, texture } = useMemo(() => pixelCanvasTexture(32, 16), []);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    paintBadge(ctx, text, 32, 16);
    texture.needsUpdate = true;
    invalidate();
  }, [ctx, texture, text, invalidate]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite position={position} scale={[0.8, 0.4, 1]}>
      <spriteMaterial map={texture} toneMapped={false} />
    </sprite>
  );
}

/** World rect of the whole suite floor (dev office + QA lab are contiguous along room-local x). */
function suiteRect(f: SuiteFrame): { cx: number; cz: number; w: number; d: number } {
  const r = roomRectToWorld(f, 'dev', { x0: 0, z0: 0, x1: DEV_LENGTH + LAB_LENGTH, z1: SLOT_DEPTH });
  return { cx: (r.x0 + r.x1) / 2, cz: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0 };
}

/** Faint aggregate-state wash over the suite floor (spec 6.6 overview tint); one plane. */
function FloorWash({ f, color }: { f: SuiteFrame; color: string }) {
  const r = useMemo(() => suiteRect(f), [f]);
  return (
    <mesh position={[r.cx, 0.04, r.cz]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[r.w, r.d]} />
      <meshBasicMaterial color={color} transparent opacity={0.12} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

const OUTLINE_T = 0.12;

/** Thin border around the whole suite floor (accent when selected, aggregate state colour otherwise); one mesh. */
function SelectionOutline({ f, color, y = 0.06 }: { f: SuiteFrame; color: string; y?: number }) {
  const r = useMemo(() => suiteRect(f), [f]);
  const shape = useMemo(() => {
    const hw = r.w / 2;
    const hd = r.d / 2;
    const s = new Shape([new Vector2(-hw, -hd), new Vector2(hw, -hd), new Vector2(hw, hd), new Vector2(-hw, hd)]);
    const t = OUTLINE_T;
    s.holes.push(new Path([new Vector2(-hw + t, -hd + t), new Vector2(-hw + t, hd - t), new Vector2(hw - t, hd - t), new Vector2(hw - t, -hd + t)]));
    return s;
  }, [r]);
  return (
    <mesh position={[r.cx, y, r.cz]} rotation={[-Math.PI / 2, 0, 0]}>
      <shapeGeometry args={[shape]} />
      <meshBasicMaterial color={color} toneMapped={false} />
    </mesh>
  );
}
