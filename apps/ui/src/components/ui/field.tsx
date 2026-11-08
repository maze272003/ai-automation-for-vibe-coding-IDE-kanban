import { useId, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Input } from './input.tsx';
import { Label } from './label.tsx';
import { Textarea } from './textarea.tsx';

export function TextField({ label, error, id: suppliedId, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} aria-invalid={error ? true : props['aria-invalid']} aria-describedby={[props['aria-describedby'], error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined} />
      {error && <p role="alert" id={`${id}-error`} className="text-xs text-danger-foreground">{error}</p>}
    </div>
  );
}

export function TextArea({ label, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Textarea id={id} {...props} />
    </div>
  );
}
