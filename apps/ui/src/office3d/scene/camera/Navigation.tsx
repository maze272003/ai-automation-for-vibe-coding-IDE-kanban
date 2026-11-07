import type { FurnitureItem, OfficePreferences } from '@aik/contracts';
import { useMemo } from 'react';
import { dataSignature } from '../../screens/data.ts';
import type { BuildingLayout } from '../../layout/building.ts';
import { wallSegments } from './collision.ts';
import { overviewPose, roomPose, walkStartPose } from './fly.ts';
import { OverviewControls } from './OverviewControls.tsx';
import { WalkControls } from './WalkControls.tsx';

/**
 * Camera navigation (spec 6.6). Overview by default; a selected room flies to its vantage; walk mode
 * replaces the map controls with first-person controls. `building.suites` must be the visible suites (the
 * collision outline follows what is drawn). `resetToken` changes on "back to overview" so Esc re-frames the
 * building even when no room was selected (after panning around).
 */
export function Navigation({
  building, layouts, prefs, selectedRoomId, walking, resetToken, onExitWalk,
}: {
  building: BuildingLayout;
  layouts: Map<number, FurnitureItem[]>;
  prefs: OfficePreferences;
  selectedRoomId: number | null;
  walking: boolean;
  resetToken: number;
  onExitWalk(): void;
}) {
  const suite = building.suites.find((s) => s.roomId === selectedRoomId) ?? null;
  // Collision outline: rebuilt only when the geometry or a furniture layout changes, and only while walking.
  const geoKey = walking ? dataSignature({ s: building.suites, h: building.hallways, l: [...layouts.entries()] }) : '';
  const segments = useMemo(() => (walking ? wallSegments(building, layouts) : []), [geoKey]); // keyed by the signature above

  if (walking) {
    return <WalkControls start={walkStartPose(suite)} segments={segments} walkSpeed={prefs.walkSpeed} mouseSensitivity={prefs.mouseSensitivity} onExit={onExitWalk} />;
  }
  const b = building.bounds;
  const poseKey = suite ? `room:${suite.roomId}:${suite.slot.wing}${suite.slot.index}${suite.slot.side}` : `overview:${b.x0},${b.z0},${b.x1},${b.z1}:${resetToken}`;
  const pose = suite ? roomPose(suite) : overviewPose(b);
  return <OverviewControls pose={pose} poseKey={poseKey} close={suite !== null} flySpeed={prefs.flySpeed} />;
}
