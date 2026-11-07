import { useState } from 'react';
import { Button } from '../../components/ui/button.tsx';
import { Dialog } from '../../components/ui/dialog.tsx';

/** A small confirm dialog: runs `onConfirm` and shows its failure inline instead of closing. */
export function ConfirmAction({
  open, title, message, confirmLabel, onConfirm, onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <p className="text-sm text-muted">{message}</p>
      {error ? <p role="alert" className="mt-2 text-xs text-danger-foreground">{error}</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" data-testid="confirm-action" disabled={busy} onClick={() => void run()}>{confirmLabel}</Button>
      </div>
    </Dialog>
  );
}
