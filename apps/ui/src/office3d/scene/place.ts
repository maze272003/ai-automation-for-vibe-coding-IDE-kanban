import type { FurnitureItem } from '@aik/contracts';
import { localToRoom } from '../layout/footprints.ts';
import { itemParts, type ModelName, type Part } from './props.ts';
import { itemYaw, roomToWorld, type SuiteFrame } from './transform.ts';

/** A voxel model instance in world space; `tint` multiplies the model's vertex colours (instance colour). */
export type Placement = { model: ModelName; x: number; y: number; z: number; yaw: number; scale: [number, number, number]; tint: string };

/** Identity frame: room-local == world (used for the hub, whose items are authored in world coordinates). */
export const WORLD_FRAME: SuiteFrame = { origin: { dev: { x: 0, z: 0 }, lab: { x: 0, z: 0 } }, ax: { x: 1, z: 0 }, az: { x: 0, z: 1 }, mirrored: false };

export type PlaceOptions = { low: boolean; accent: string; dim: boolean };

const WHITE = '#ffffff';
const DIM = '#707070';

/** Accent tint for chair fabric: the accent mixed toward white so the voxel shading still reads. */
export function accentTint(accent: string, dim: boolean): string {
  const n = parseInt(accent.slice(1), 16);
  const mix = (c: number) => Math.round((c * 0.7 + 255 * 0.3) * (dim ? 0.44 : 1));
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export function placeParts(frame: SuiteFrame, item: Pick<FurnitureItem, 'area' | 'x' | 'z' | 'rotationY'>, parts: Part[], o: PlaceOptions): Placement[] {
  const out: Placement[] = [];
  for (const part of parts) {
    if (o.low && part.detail) continue;
    const local = localToRoom(item, part.x, part.z);
    const w = roomToWorld(frame, item.area, local.x, local.z);
    out.push({
      model: part.model,
      x: w.x,
      y: part.y,
      z: w.z,
      yaw: itemYaw(frame, item.rotationY + part.rot),
      scale: part.scale,
      tint: part.accent ? accentTint(o.accent, o.dim) : o.dim ? DIM : WHITE,
    });
  }
  return out;
}

/** World placements of a layout item; `seats` = seats currently shown at a station. */
export function placeItem(frame: SuiteFrame, item: FurnitureItem, seats: number, o: PlaceOptions): Placement[] {
  return placeParts(frame, item, itemParts(item, seats), o);
}
