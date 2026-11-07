import { useThree } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import type { ROOM_ICONS } from '@aik/contracts';
import { paintSign } from '../screens/paint.ts';
import { pixelCanvasTexture } from './materials.ts';


/** A pixel-font sign (`paintSign` -> CanvasTexture); repainted only when its text, colour or icon changes. */
export function Sign({ text, accent, icon = null, position, yaw, width, dim = false, px = 256 }: {
  text: string;
  accent: string;
  icon?: (typeof ROOM_ICONS)[number] | null;
  position: [number, number, number];
  yaw: number;
  /** Width in metres; height follows the 8:1 canvas aspect. */
  width: number;
  dim?: boolean;
  /** Canvas width in pixels (32 px tall); wider canvases fit longer names at the same pixel size. */
  px?: number;
}) {
  const pw = px;
  const ph = 32;
  const { ctx, texture } = useMemo(() => pixelCanvasTexture(pw, ph), [pw, ph]);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    paintSign(ctx, text, accent, icon, pw, ph);
    texture.needsUpdate = true;
    invalidate();
  }, [ctx, texture, text, accent, icon, pw, ph, invalidate]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <mesh position={position} rotation={[0, yaw, 0]}>
      <planeGeometry args={[width, (width * ph) / pw]} />
      <meshBasicMaterial map={texture} toneMapped={false} color={dim ? '#666666' : '#ffffff'} />
    </mesh>
  );
}
