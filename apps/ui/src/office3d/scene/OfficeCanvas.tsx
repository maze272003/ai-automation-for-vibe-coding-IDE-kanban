import type { OfficePreferences, StationRole } from '@aik/contracts';
import { Canvas, useThree } from '@react-three/fiber';
import { Component, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { dataSignature } from '../screens/data.ts';
import type { FigureState } from '../state/figures.ts';
import type { OfficeState } from '../state/model.ts';
import { Agents } from './Agents.tsx';
import { Building, type OpsTile } from './Building.tsx';
import { Navigation } from './camera/Navigation.tsx';
import { sceneModel, stateColor, type SuiteModel } from './derive.ts';
import { hubPlacements, hubStructure } from './hub.ts';
import { Lighting } from './Lighting.tsx';
import { placeItem, type Placement } from './place.ts';
import { qualitySettings } from './quality.ts';
import { StatusRings } from './StatusRings.tsx';
import { emptyStructure, shellStructure, suiteStructure, COLORS, type Structure } from './structure.ts';
import { Suite } from './Suite.tsx';
import { suiteFrame } from './transform.ts';
import { VoxelInstances } from './VoxelInstances.tsx';
import { Whiteboards } from './Whiteboard.tsx';

export type OfficeCanvasProps = {
  state: OfficeState;
  now: number;
  prefs: OfficePreferences;
  selectedRoomId: number | null;
  onSelectRoom(id: number | null): void;
  onStationClick(roomId: number, role: StationRole): void;
  /** First-person walk mode (spec 6.6); the route owns the toggle (V) and exit (Esc). */
  walking?: boolean;
  /** Changes on "back to overview" (Esc) so the overview is re-framed even with no room selected. */
  resetToken?: number;
  onExitWalk?(): void;
  children?: ReactNode;
};

/**
 * Render-on-demand gate. Frames are drawn only when something visible changes: every `state` change
 * (live events) invalidates explicitly; `now` ticks (2x/s) do NOT force a frame by themselves; time-driven
 * changes (e.g. a completed light expiring) reach the scene as changed props, which React Three Fiber
 * applies with its own invalidate. So an idle office draws no frames. While the page is hidden the
 * frameloop is switched to 'never' (render loop fully stopped); unmounting the route disposes the canvas.
 */
function RenderGate({ state }: { state: OfficeState }) {
  const invalidate = useThree((s) => s.invalidate);
  const setFrameloop = useThree((s) => s.setFrameloop);
  useEffect(() => {
    invalidate();
  }, [state, invalidate]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) setFrameloop('never');
      else {
        setFrameloop('demand');
        invalidate();
      }
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [setFrameloop, invalidate]);
  return null;
}

class CanvasErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (this.state.failed) {
      return (
        <p data-testid="office-canvas-error" className="p-6 text-sm text-muted">
          The 3D view could not start (WebGL unavailable). The room list on the right still works.
        </p>
      );
    }
    return this.props.children;
  }
}

/** A callback with a stable identity that always calls the latest `fn`. */
function useStableCallback(fn: (() => void) | undefined): () => void {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback(() => ref.current?.(), []);
}

/** Keeps object identity for suites whose data did not change, so memoised children skip re-rendering. */
function useStableSuites(suites: SuiteModel[]): SuiteModel[] {
  const cache = useRef(new Map<number, { sig: string; model: SuiteModel }>());
  const last = useRef<SuiteModel[]>([]);
  const next = suites.map((m) => {
    const sig = dataSignature(m);
    const hit = cache.current.get(m.roomId);
    if (hit && hit.sig === sig) return hit.model;
    cache.current.set(m.roomId, { sig, model: m });
    return m;
  });
  const same = next.length === last.current.length && next.every((m, i) => m === last.current[i]);
  if (!same) last.current = next;
  return last.current;
}

export function OfficeCanvas({ state, now, prefs, selectedRoomId, onSelectRoom, onStationClick, walking = false, resetToken = 0, onExitWalk, children }: OfficeCanvasProps) {
  const q = qualitySettings(prefs.quality);
  const low = prefs.quality === 'low';
  const scene = useMemo(() => sceneModel(state, now, prefs), [state, now, prefs]);
  const suites = useStableSuites(scene.suites);
  const building = scene.building;
  // The agent figures (spec 6.5a): advanced by Agents with stepFigures; kept across re-renders and Canvas re-creation.
  const figures = useRef(new Map<string, FigureState>());

  // Static shell: recomputed only when geometry-relevant inputs change.
  const structureKey = dataSignature({
    b: building,
    v: [...scene.visibleSlots].sort(),
    s: suites.map((s) => [s.roomId, s.dim !== null, s.accent]),
  });
  const structure = useMemo<Structure>(() => {
    const s = emptyStructure();
    shellStructure(s, building, scene.visibleSlots);
    hubStructure(s);
    for (const m of suites) suiteStructure(s, m.suite, { roomId: m.roomId, dim: m.dim !== null, accent: m.accent });
    return s;
  }, [structureKey]); // keyed by the signature above

  // Prop placements change only with layout, seat counts, accent or dim state.
  const placementKey = dataSignature({ low, s: suites.map((s) => [s.roomId, s.suite, s.layout, s.accent, s.dim, Object.values(s.seats).map((x) => x.length)]) });
  const placements = useMemo<Placement[]>(() => {
    const out = hubPlacements(low);
    for (const m of suites) {
      const f = suiteFrame(m.suite);
      const o = { low, accent: m.accent, dim: m.dim !== null };
      for (const item of m.layout) out.push(...placeItem(f, item, item.kind === 'station' && item.role ? m.seats[item.role].length : 1, o));
    }
    return out;
  }, [placementKey]); // keyed by the signature above

  const ops = useMemo<OpsTile[]>(
    () => suites.filter((s) => s.dim !== 'archived').map((s) => ({ key: s.projectKey, color: stateColor(s.aggregate, prefs.statusColors) })),
    [suites, prefs.statusColors],
  );
  // Navigation sees only the visible suites (camera targets and the walk-mode collision follow what is drawn).
  const navBuilding = useMemo(() => ({ ...building, suites: suites.map((m) => m.suite) }), [building, suites]);
  const navLayouts = useMemo(() => new Map(suites.map((m) => [m.roomId, m.layout])), [suites]);
  const exitWalk = useStableCallback(onExitWalk);

  return (
    <CanvasErrorBoundary>
      <Canvas
        key={q.antialias ? 'msaa' : 'plain'}
        frameloop="demand"
        dpr={q.dpr}
        shadows={q.shadows}
        gl={{ antialias: q.antialias, powerPreference: 'high-performance' }}
        camera={{ fov: 40, near: 1, far: 1500, position: [60, 60, 60] }}
        style={{ width: '100%', height: '100%' }}
      >
        <color attach="background" args={[COLORS.slab]} />
        <RenderGate state={state} />
        <Lighting {...building.bounds} shadows={q.shadows} />
        <Building structure={structure} glassOpacity={q.glassOpacity} shadows={q.shadows} ops={ops} onSelectRoom={onSelectRoom} />
        <VoxelInstances placements={placements} shadows={q.shadows} />
        <StatusRings suites={suites} statusColors={prefs.statusColors} onStationClick={onStationClick} />
        {suites.map((m) => (
          <Suite key={m.roomId} model={m} prefs={prefs} selected={m.roomId === selectedRoomId} />
        ))}
        <Whiteboards suites={suites} state={state} />
        <Agents state={state} now={now} suites={suites} prefs={prefs} selectedRoomId={selectedRoomId} figures={figures} onStationClick={onStationClick} />
        <Navigation
          building={navBuilding}
          layouts={navLayouts}
          prefs={prefs}
          selectedRoomId={selectedRoomId}
          walking={walking}
          resetToken={resetToken}
          onExitWalk={exitWalk}
        />
        {children}
      </Canvas>
    </CanvasErrorBoundary>
  );
}
