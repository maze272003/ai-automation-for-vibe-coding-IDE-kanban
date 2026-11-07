import type { OfficePreferences, StationRole } from '@aik/contracts';
import type { ThreeEvent } from '@react-three/fiber';
import { memo, useMemo } from 'react';
import { localToRoom } from '../layout/footprints.ts';
import { stateColor, type SuiteModel } from './derive.ts';
import { capacityFor, useInstances, useStableHandler, type InstanceSpec } from './instancing.ts';
import { ringGeometry, ringMaterial } from './materials.ts';
import { stationSeatOffsets } from './props.ts';
import { shade } from './structure.ts';
import { roomToWorld, suiteFrame } from './transform.ts';

type RingTarget = { roomId: number; role: StationRole };

/** Pure: one floor ring per station seat (under the chair), coloured by the seat's state. */
export function ringSpecs(suites: SuiteModel[], overrides: OfficePreferences['statusColors']): { specs: InstanceSpec[]; targets: RingTarget[] } {
  const specs: InstanceSpec[] = [];
  const targets: RingTarget[] = [];
  for (const s of suites) {
    const f = suiteFrame(s.suite);
    for (const item of s.layout) {
      if (item.kind !== 'station' || !item.role) continue;
      const states = s.seats[item.role];
      stationSeatOffsets(item.role, states.length).forEach((off, i) => {
        const p = localToRoom(item, off.x, off.z);
        const w = roomToWorld(f, item.area, p.x, p.z);
        const c = stateColor(states[i] ?? 'idle', overrides);
        specs.push({ x: w.x, y: 0.045, z: w.z, yaw: 0, sx: 1, sy: 1, sz: 1, color: s.dim ? shade(c, 0.4) : c });
        targets.push({ roomId: s.roomId, role: item.role! });
      });
    }
  }
  return { specs, targets };
}

/** Status rings of every suite in one InstancedMesh; clicking a ring opens that station. */
export const StatusRings = memo(function StatusRings({ suites, statusColors, onStationClick }: {
  suites: SuiteModel[];
  statusColors: OfficePreferences['statusColors'];
  onStationClick(roomId: number, role: StationRole): void;
}) {
  const { specs, targets } = useMemo(() => ringSpecs(suites, statusColors), [suites, statusColors]);
  const capacity = capacityFor(specs.length);
  const ref = useInstances(specs, capacity);
  const onClick = useStableHandler((e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 4 || e.instanceId === undefined) return;
    const t = targets[e.instanceId];
    if (!t) return;
    e.stopPropagation();
    onStationClick(t.roomId, t.role);
  });
  return <instancedMesh key={capacity} ref={ref} args={[ringGeometry, ringMaterial, capacity]} onClick={onClick} />;
});
