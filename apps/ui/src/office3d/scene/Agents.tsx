import { STATION_ROLES, type OfficePreferences, type StationRole } from '@aik/contracts';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { Mesh, Vector3, type Group, type PlaneGeometry } from 'three';
import type { Vec2 } from '../layout/geometry.ts';
import { buildWaypointGraph, type SpotKind, type WaypointGraph } from '../layout/waypoints.ts';
import { dataSignature } from '../screens/data.ts';
import { effectiveMovement } from '../state/customization.ts';
import { stepFigures, type FigureState } from '../state/figures.ts';
import type { OfficeState } from '../state/model.ts';
import { Bubbles, type BubbleItem, type BubbleUpdate } from './Bubbles.tsx';
import type { SuiteModel } from './derive.ts';
import { useStableHandler } from './instancing.ts';
import { bubbleText, facingFor, figureFrame, padRows, POSE_PERIOD_MS, type Facing, type FrameName } from './pose.ts';
import { figureGeometry, setFrameUv, sheetFor, SPRITE_H, SPRITE_PX, SPRITE_W, type Sheet } from './SpriteMaterial.ts';
import { roomDirToWorld, suiteFrame, suiteToWorld, type SuiteFrame } from './transform.ts';

/** Longest simulation step per rendered frame (a frame after a long idle gap must not teleport figures). */
const MAX_STEP_MS = 100;
/** Gap between the top of the sprite and the bubble's tail. */
const BUBBLE_GAP = 0.1;
/** Figures are drawn this far toward the camera from their feet (avoids clipping into the desk behind). */
const TOWARD_CAMERA_M = 0.6;

type Entry = { mesh: Mesh; geometry: PlaneGeometry; sheet: Sheet; walked: number; last: Vec2; frame: FrameName | null; facing: Facing | null };

export type AgentsProps = {
  state: OfficeState;
  /** The 2 Hz clock: drives time-based transitions (idle -> thinking, holds, departures) and pose animation. */
  now: number;
  suites: SuiteModel[];
  prefs: OfficePreferences;
  selectedRoomId: number | null;
  /** The figure simulation (owned by OfficeCanvas): advanced here with `stepFigures`. */
  figures: MutableRefObject<Map<string, FigureState>>;
  onStationClick(roomId: number, role: StationRole): void;
};

/** Seats shown per station (the same counts the desks and status rings use), for the waypoint graph. */
const seatCounts = (s: SuiteModel): Partial<Record<StationRole, number>> =>
  Object.fromEntries(STATION_ROLES.map((r) => [r, s.seats[r].length]));

/** Visible state of the simulation: a change requests one frame; an idle office requests none. */
export function figuresSignature(figs: Map<string, FigureState>, kindOf: (f: FigureState) => SpotKind | null, nowMs: number): string {
  let animated = false;
  const parts: string[] = [];
  for (const f of figs.values()) {
    parts.push(`${f.id}|${f.spotId}|${f.activity}|${f.bubble}|${f.leaving}|${f.path.length > 0}|${f.pos.x},${f.pos.z}`);
    if (f.path.length === 0 && figureFrame(f, kindOf(f), 0, nowMs).animated) animated = true;
  }
  // Two-frame poses (typing, writing, gesturing) flip at 2 Hz only while such a figure exists.
  if (animated) parts.push(`phase:${Math.floor(nowMs / POSE_PERIOD_MS) % 2}`);
  return parts.join(';');
}

const camDir = new Vector3();
const camUp = new Vector3();
const feet = new Vector3();
const toCam = new Vector3();
const top = new Vector3();

/**
 * Pixel-art agents: one camera-facing sprite quad per figure (one shared texture + material per role/variant
 * sheet, nearest-filtered, alpha-tested), walking to their activity spots along each suite's waypoint graph.
 * Frames are rendered only while a figure walks or animates; an office without figures draws nothing.
 * Clicking a figure opens its station (`onStationClick`).
 */
export function Agents({ state, now, suites, prefs, selectedRoomId, figures, onStationClick }: AgentsProps) {
  const invalidate = useThree((s) => s.invalidate);
  const movement = effectiveMovement(prefs);
  const group = useRef<Group>(null);
  const entries = useRef(new Map<string, Entry>());
  const bubbles = useRef<BubbleUpdate | null>(null);
  const lastSig = useRef('');
  const latest = useRef({ state, movement });
  latest.current = { state, movement };

  // Waypoint graphs per suite, rebuilt only when a layout or a seat count changes.
  const graphKey = dataSignature(suites.map((s) => [s.roomId, s.layout, seatCounts(s)]));
  const graphs = useMemo(() => new Map<number, WaypointGraph>(suites.map((s) => [s.roomId, buildWaypointGraph(s.layout, seatCounts(s))])), [graphKey]); // keyed by the signature above
  const frameKey = dataSignature(suites.map((s) => [s.roomId, s.suite]));
  const frames = useMemo(() => new Map<number, SuiteFrame>(suites.map((s) => [s.roomId, suiteFrame(s.suite)])), [frameKey]); // keyed by the signature above
  const kinds = useMemo(() => {
    const m = new Map<number, Map<string, SpotKind>>();
    for (const [roomId, g] of graphs) m.set(roomId, new Map(g.spots.map((s) => [s.id, s.kind])));
    return m;
  }, [graphs]);
  const kindOf = (f: FigureState): SpotKind | null => kinds.get(f.roomId)?.get(f.spotId) ?? null;

  // A rebuilt graph can move a seat (e.g. a second reviewer seat re-centres the first): stationary figures snap.
  useEffect(() => {
    for (const f of figures.current.values()) {
      if (f.path.length > 0) continue;
      const spot = graphs.get(f.roomId)?.spots.find((s) => s.id === f.spotId);
      if (spot) f.pos = { x: spot.pos.x, z: spot.pos.z };
    }
    invalidate();
  }, [graphs, figures, invalidate]);

  // Event- and time-driven updates (spawn, activity changes, holds, departures). Walking happens in useFrame.
  useEffect(() => {
    const nowMs = Date.now();
    figures.current = stepFigures(figures.current, state, graphs, { agentMovement: movement }, nowMs, 0);
    const sig = figuresSignature(figures.current, kindOf, nowMs);
    if (sig !== lastSig.current) {
      lastSig.current = sig;
      invalidate();
    }
    // kindOf derives from `graphs` (a dependency); figures is a stable ref.
  }, [state, now, graphs, movement, figures, invalidate]);

  useFrame((three, delta) => {
    const g = group.current;
    if (!g) return;
    const nowMs = Date.now();
    let figs = figures.current;
    let moving = false;
    for (const f of figs.values()) if (f.path.length > 0) moving = true;
    if (moving) {
      const { state: s, movement: mv } = latest.current;
      figs = stepFigures(figs, s, graphs, { agentMovement: mv }, nowMs, Math.min(delta * 1000, MAX_STEP_MS));
      figures.current = figs;
    }

    // Sprites face the camera (same orientation as the camera, so they are never foreshortened); the walk facing
    // uses the camera's horizontal basis. Looking straight down, the screen's up vector stands in for forward.
    const cam = three.camera;
    camUp.set(0, 1, 0).applyQuaternion(cam.quaternion);
    cam.getWorldDirection(camDir);
    let fx = camDir.x;
    let fz = camDir.z;
    if (Math.hypot(fx, fz) < 1e-3) {
      fx = camUp.x;
      fz = camUp.z;
    }
    const len = Math.hypot(fx, fz) || 1;
    const forward = { x: fx / len, z: fz / len };
    const right = { x: -forward.z, z: forward.x };

    const map = entries.current;
    const items: BubbleItem[] = [];
    for (const [id, e] of map) {
      if (figs.has(id)) continue;
      g.remove(e.mesh);
      e.geometry.dispose();
      map.delete(id);
    }
    for (const f of figs.values()) {
      const sf = frames.get(f.roomId);
      if (!sf) continue;
      let e = map.get(f.id);
      if (!e) {
        const geometry = figureGeometry();
        const sheet = sheetFor(f.role, f.variant);
        const mesh = new Mesh(geometry, sheet.material);
        mesh.scale.set(SPRITE_W, SPRITE_H, 1);
        mesh.userData = { roomId: f.roomId, role: f.role };
        g.add(mesh);
        e = { mesh, geometry, sheet, walked: 0, last: { ...f.pos }, frame: null, facing: null };
        map.set(f.id, e);
      }
      e.walked += Math.hypot(f.pos.x - e.last.x, f.pos.z - e.last.z);
      e.last = { ...f.pos };
      const { frame } = figureFrame(f, kindOf(f), e.walked, nowMs);
      let facing: Facing = 'front';
      const next = f.path[0];
      if (next) facing = facingFor(roomDirToWorld(sf, next.x - f.pos.x, next.z - f.pos.z), right, forward);
      if (frame !== e.frame || facing !== e.facing) {
        setFrameUv(e.geometry, e.sheet, frame, facing);
        e.frame = frame;
        e.facing = facing;
      }
      const w = suiteToWorld(sf, f.pos);
      const drop = padRows(frame) * SPRITE_PX; // seated frames: anchor on the last non-empty row
      // The quad leans back with the camera pitch: nudge it toward the camera along the view ray (its projected
      // position does not change) so the desk behind a seated figure does not cut through it.
      feet.set(w.x, 0, w.z);
      toCam.copy(cam.position).sub(feet).normalize().multiplyScalar(TOWARD_CAMERA_M);
      e.mesh.position.copy(feet).addScaledVector(camUp, -drop).add(toCam);
      e.mesh.quaternion.copy(cam.quaternion);
      top.copy(feet).addScaledVector(camUp, SPRITE_H - drop + BUBBLE_GAP);
      items.push({ id: f.id, roomId: f.roomId, x: top.x, y: top.y, z: top.z, text: bubbleText(f.bubble) });
    }
    bubbles.current?.(items);
    if (moving) invalidate();
  });

  useEffect(
    () => () => {
      for (const e of entries.current.values()) e.geometry.dispose();
      entries.current.clear();
    },
    [],
  );

  const onClick = useStableHandler((e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 4) return;
    const ud = e.object.userData as { roomId?: number; role?: StationRole };
    if (ud.roomId === undefined || !ud.role) return;
    e.stopPropagation();
    onStationClick(ud.roomId, ud.role);
  });

  return (
    <>
      <group ref={group} onClick={onClick} />
      <Bubbles suites={suites} selectedRoomId={selectedRoomId} update={bubbles} />
    </>
  );
}
