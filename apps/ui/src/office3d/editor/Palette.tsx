import { FURNITURE_KINDS } from '@aik/contracts';
import { Button } from '../../components/ui/button.tsx';

export type EditorArea = 'dev' | 'lab';

/** Add-furniture palette: one button per free-standing kind, dropped into the chosen area. */
export function Palette({ area, onArea, onAdd }: { area: EditorArea; onArea: (a: EditorArea) => void; onAdd: (kind: (typeof FURNITURE_KINDS)[number]) => void }) {
  return (
    <div data-testid="editor-palette" className="flex flex-col gap-2 text-sm">
      <div role="radiogroup" aria-label="Add to area" className="flex gap-1">
        {(['dev', 'lab'] as const).map((a) => (
          <Button
            key={a}
            role="radio"
            aria-checked={area === a}
            data-testid={`editor-area-${a}`}
            onClick={() => onArea(a)}
            className={area === a ? 'ring-1 ring-accent' : ''}
          >
            {a === 'dev' ? 'Dev office' : 'QA lab'}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1">
        {FURNITURE_KINDS.map((k) => (
          <Button key={k} data-testid={`editor-add-${k}`} aria-label={`Add ${k}`} onClick={() => onAdd(k)}>
            {k}
          </Button>
        ))}
      </div>
    </div>
  );
}
