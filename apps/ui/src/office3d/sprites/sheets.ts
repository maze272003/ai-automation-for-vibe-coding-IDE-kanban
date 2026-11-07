/**
 * Code-defined pixel-art character frames. Every frame is 12 columns x 17 rows
 * of palette keys ('.' = transparent). Layout: 7 head rows + 10 body rows.
 * Standing frames fill all 10 body rows (feet on the last row). Seated frames
 * have an 8-row body and are padded with 2 transparent rows at the BOTTOM, so
 * the scene should anchor seated sprites by their last non-empty row (the seat)
 * rather than the frame bottom.
 */
export const SPRITE_WIDTH = 12;
export const SPRITE_HEIGHT = 17;

const HEAD = [
  '...HHHHHH...',
  '..HHHHHHHH..',
  '..HSSSSSSH..',
  '..SSESSESS..',
  '..SSSSSSSS..',
  '...SSMMSS...',
  '....SSSS....',
];

const PAD2 = ['............', '............'];
const LEGS_STAND = ['...PPPPPP...', '...PP..PP...', '...PP..PP...', '...PP..PP...', '..BBB..BBB..'];
const LEGS_STRIDE = ['...PPPPPP...', '..PPP..PPP..', '..PP....PP..', '..PP....PP..', '.BBB....BBB.'];
const LEGS_PASS = ['...PPPPPP...', '...PP..PP...', '...PP..PP...', '...PP..PP...', '...BB..BB...'];
const SIT_LEGS = ['..PPPPPPPP..', '..PPPPPPPP..', '..PP....PP..', '..BB....BB..'];

const f = (...body: string[]): string[] => [...HEAD, ...body];

export const SPRITE_FRAMES: Record<
  | 'idle'
  | 'walk-0'
  | 'walk-1'
  | 'walk-2'
  | 'walk-3'
  | 'sit-type-0'
  | 'sit-type-1'
  | 'sit-read'
  | 'sip'
  | 'touch'
  | 'write-0'
  | 'write-1'
  | 'thumbs-up',
  string[]
> = {
  idle: f('..TTTTTTTT..', '.STTTTTTttS.', '.STTTTTTttS.', '.STTTTTTttS.', '..TTTTTTtt..', ...LEGS_STAND),
  'walk-0': f('..TTTTTTTT..', '.STTTTTTtt..', 'S.TTTTTTtt.S', '..TTTTTTtt..', '..TTTTTTtt..', ...LEGS_STRIDE),
  'walk-1': f('..TTTTTTTT..', '.STTTTTTttS.', '.STTTTTTttS.', '..TTTTTTtt..', '..TTTTTTtt..', ...LEGS_PASS),
  'walk-2': f('..TTTTTTTT..', '..TTTTTTttS.', 'S.TTTTTTtt.S', '..TTTTTTtt..', '..TTTTTTtt..', ...LEGS_STRIDE),
  'walk-3': f('..TTTTTTTT..', '.STTTTTTttS.', '.STTTTTTttS.', '..TTTTTTtt..', '..TTTTTTtt..', ...LEGS_PASS),
  'sit-type-0': f('..TTTTTTTT..', '.STTTTTTttS.', '.SSTTTTTtSS.', '..TTTTTTtt..', ...SIT_LEGS, ...PAD2),
  'sit-type-1': f('..TTTTTTTT..', '.STTTTTTttS.', 'SS.TTTTTtSS.', '..TTTTTTtt..', ...SIT_LEGS, ...PAD2),
  'sit-read': f('..TTTTTTTT..', '.STTTTTTttS.', '..SWWWWWWS..', '..WWKWWKWW..', ...SIT_LEGS, ...PAD2),
  sip: f('..TTTTTTTT..', '.STTTTTTttWW', '.STTTTTTttWC', '.STTTTTTtSWW', '..TTTTTTtt..', ...LEGS_STAND),
  touch: f('..TTTTTTTTSS', '.STTTTTTtt.S', '.STTTTTTtt..', '.STTTTTTtt..', '..TTTTTTtt..', ...LEGS_STAND),
  'write-0': f('..TTTTTTTT..', '.STTTTTTttS.', '.SSTTTTTtt..', '..TTTTTTtt..', ...SIT_LEGS, ...PAD2),
  'write-1': f('..TTTTTTTT..', '.STTTTTTttS.', '.STSTTTTtt..', '..TTTTTTtt..', ...SIT_LEGS, ...PAD2),
  'thumbs-up': f('..TTTTTTTT.S', '.STTTTTTttSS', '.STTTTTTtt..', '.STTTTTTtt..', '..TTTTTTtt..', ...LEGS_STAND),
};

export type FrameRect = { x: number; y: number; w: number; h: number };

const SHEET_COLS = 5;

/**
 * Paints every frame into a sheet (5 frames per row, no gutter, row-major in
 * object key order). Wrap the resulting canvas in a CanvasTexture with
 * NearestFilter. `width`/`height` give the required canvas size in pixels.
 */
export function renderSheet(
  frames: typeof SPRITE_FRAMES,
  palette: Record<string, string>,
  scale: number,
  ctx: { fillStyle: string; fillRect(x: number, y: number, w: number, h: number): void },
): { frameRects: Record<string, FrameRect>; width: number; height: number } {
  const frameRects: Record<string, FrameRect> = {};
  const w = SPRITE_WIDTH * scale;
  const h = SPRITE_HEIGHT * scale;
  const names = Object.keys(frames) as Array<keyof typeof SPRITE_FRAMES>;
  names.forEach((name, n) => {
    const ox = (n % SHEET_COLS) * w;
    const oy = Math.floor(n / SHEET_COLS) * h;
    frameRects[name] = { x: ox, y: oy, w, h };
    frames[name].forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        const colour = row[i] === '.' ? undefined : palette[row[i]!];
        if (colour === undefined) continue;
        ctx.fillStyle = colour;
        ctx.fillRect(ox + i * scale, oy + j * scale, scale, scale);
      }
    });
  });
  return { frameRects, width: SHEET_COLS * w, height: Math.ceil(names.length / SHEET_COLS) * h };
}
