import { useId, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Input } from './input.tsx';
import { Label } from './label.tsx';
import { Textarea } from './textarea.tsx';

export function TextField({ label, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
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
