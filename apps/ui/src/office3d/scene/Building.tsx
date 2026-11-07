import type { ThreeEvent } from '@react-three/fiber';
import { memo, useMemo } from 'react';
import type { Material } from 'three';
import { GLYPH_H, measurePixelText, paintPixelText, type Ctx2D } from '../screens/pixel-font.ts';
import { capacityFor, useInstances, useStableHandler, type InstanceSpec } from './instancing.ts';
import { floorMaterial, frameMaterial, glassMaterial, solidMaterial, unitBox, unitFloor } from './materials.ts';
import { OPS_WALL, RECEPTION_SIGN } from './hub.ts';
import { Screen } from './Screen.tsx';
import { Sign } from './Sign.tsx';
import type { Box, Floor, Structure } from './structure.ts';

const boxSpec = (b: Box, color: string): InstanceSpec => ({
  x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: (b.z0 + b.z1) / 2, yaw: 0, sx: b.x1 - b.x0, sy: b.y1 - b.y0, sz: b.z1 - b.z0, color,
});

function Boxes({ boxes, material, color, shadows }: { boxes: Box[]; material: Material; color?: string; shadows: boolean }) {
  const specs = useMemo(() => boxes.map((b) => boxSpec(b, color ?? b.color)), [boxes, color]);
  const capacity = capacityFor(specs.length);
  const ref = useInstances(specs, capacity);
  return <instancedMesh key={capacity} ref={ref} args={[unitBox, material, capacity]} castShadow={shadows} receiveShadow={shadows} />;
}

function Floors({ floors, shadows, onSelectRoom }: { floors: Floor[]; shadows: boolean; onSelectRoom(id: number | null): void }) {
  const specs = useMemo(
    () => floors.map((f): InstanceSpec => ({ x: (f.rect.x0 + f.rect.x1) / 2, y: f.y, z: (f.rect.z0 + f.rect.z1) / 2, yaw: 0, sx: f.rect.x1 - f.rect.x0, sy: 1, sz: f.rect.z1 - f.rect.z0, color: f.color })),
    [floors],
  );
  const capacity = capacityFor(specs.length);
  const ref = useInstances(specs, capacity);
  const onClick = useStableHandler((e: ThreeEvent<MouseEvent>) => {
    // A drag (camera orbit) is not a click.
    if (e.delta > 4 || e.instanceId === undefined) return;
    e.stopPropagation();
    onSelectRoom(floors[e.instanceId]?.roomId ?? null);
  });
  return <instancedMesh key={capacity} ref={ref} args={[unitFloor, floorMaterial, capacity]} receiveShadow={shadows} onClick={onClick} />;
}

export type OpsTile = { key: string; color: string };
const OPS_PX: [number, number] = [320, 80];
const OPS_COLS = 8;
const OPS_ROWS = 5;

/** AI Ops wall: one tile per room in its aggregate status colour, with the project key. */
export function paintOps(ctx: Ctx2D, tiles: OpsTile[], w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, w, h);
  paintPixelText(ctx, 'AI OPS', 3, 2, 1, '#38bdf8');
  const top = GLYPH_H + 4;
  const tw = Math.floor(w / OPS_COLS);
  const th = Math.floor((h - top) / OPS_ROWS);
  const max = OPS_COLS * OPS_ROWS;
  const shown = tiles.length > max ? tiles.slice(0, max - 1) : tiles;
  shown.forEach((t, i) => {
    const x = (i % OPS_COLS) * tw;
    const y = top + Math.floor(i / OPS_COLS) * th;
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(x + 1, y + 1, tw - 2, th - 2);
    ctx.fillStyle = t.color;
    ctx.fillRect(x + 1, y + 1, 3, th - 2);
    paintPixelText(ctx, t.key.slice(0, Math.floor((tw - 8) / 6)), x + 6, y + Math.floor((th - GLYPH_H) / 2), 1, '#e2e8f0');
  });
  if (tiles.length > max) {
    const label = `+${tiles.length - shown.length}`;
    paintPixelText(ctx, label, w - measurePixelText(label, 1) - 4, h - GLYPH_H - 3, 1, '#e2e8f0');
  }
}

/**
 * The building shell: slab, floors (suite floors select their room on click), walls, glass and frames,
 * all instanced; plus the hub's AI Ops screen wall and reception sign. Ceilings are cut away (overview).
 */
export const Building = memo(function Building({ structure, glassOpacity, shadows, ops, onSelectRoom }: {
  structure: Structure;
  glassOpacity: number | null;
  shadows: boolean;
  ops: OpsTile[];
  onSelectRoom(id: number | null): void;
}) {
  const glass = glassMaterial(glassOpacity);
  return (
    <group>
      <Floors floors={structure.floors} shadows={shadows} onSelectRoom={onSelectRoom} />
      <Boxes boxes={structure.solid} material={solidMaterial} shadows={shadows} />
      <Boxes boxes={structure.frame} material={frameMaterial} shadows={false} />
      <Boxes key={String(glassOpacity)} boxes={structure.glass} material={glass} color="#ffffff" shadows={false} />
      <Screen data={ops} paint={paintOps} px={OPS_PX} size={[OPS_WALL.w, OPS_WALL.h]} position={[OPS_WALL.x, OPS_WALL.y, OPS_WALL.z]} yaw={0} />
      <Sign text="RECEPTION" accent="#38bdf8" position={[RECEPTION_SIGN.x, RECEPTION_SIGN.y, RECEPTION_SIGN.z]} yaw={0} width={RECEPTION_SIGN.w} />
    </group>
  );
});
