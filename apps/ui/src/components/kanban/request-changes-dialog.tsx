// apps/ui/src/components/kanban/request-changes-dialog.tsx
import { useState } from 'react';
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { TextArea } from '../ui/field.tsx';

export function RequestChangesDialog({ open, onAnswer }: { open: boolean; onAnswer: (text: string | null) => void }) {
  const [text, setText] = useState('');
  return (
    <Dialog open={open} title="Request changes" onClose={() => onAnswer(null)}>
      <TextArea label="What must change?" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => onAnswer(null)}>Back</Button>
        <Button variant="primary" disabled={!text.trim()} onClick={() => { onAnswer(text.trim()); setText(''); }}>Send to rework</Button>
      </div>
    </Dialog>
  );
}
