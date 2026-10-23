// apps/ui/src/components/kanban/confirm-dialog.tsx
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';

export function ConfirmDialog({ message, onAnswer }: { message: string | null; onAnswer: (ok: boolean) => void }) {
  return (
    <Dialog open={message !== null} title="Please confirm" onClose={() => onAnswer(false)}>
      <p className="text-sm text-muted">{message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => onAnswer(false)}>Keep story</Button>
        <Button variant="danger" onClick={() => onAnswer(true)}>Cancel story</Button>
      </div>
    </Dialog>
  );
}
