// apps/ui/src/components/kanban/clarifications-dialog.tsx
import { useState } from 'react';
import type { ClarificationAnswer } from '../../lib/transitions.ts';
import { Button } from '../ui/button.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { TextArea, TextField } from '../ui/field.tsx';

/** One open planner question; the ordinal is its 1-based position in the plan's clarificationQuestions. */
export interface ClarificationQuestion {
  ordinal: number;
  question: string;
}

/** Small modal asking why the proposed plan must be re-planned; null answer = the user backed out. */
export function RejectPlanDialog({ open, onAnswer }: { open: boolean; onAnswer: (feedback: string | null) => void }) {
  const [text, setText] = useState('');
  return (
    <Dialog open={open} title="Reject plan" onClose={() => onAnswer(null)}>
      <p className="mb-2 text-sm">The plan is marked rejected and the planner re-plans with your feedback.</p>
      <TextArea
        label="What must the new plan fix?"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={5000}
        placeholder="What is wrong and what the re-plan should do differently"
      />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={() => onAnswer(null)}>Back</Button>
        <Button
          variant="danger"
          disabled={!text.trim()}
          onClick={() => {
            onAnswer(text.trim());
            setText('');
          }}
        >
          Reject & re-plan
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * Inline answer form for a story in needs_clarification: one input per open question, all sent
 * in a single request (the transition requires every open ordinal answered at once). Unmounts
 * when the story leaves needs_clarification, so state resets between plan versions.
 */
export function ClarificationAnswersForm({
  questions,
  busy = false,
  onSubmit,
}: {
  questions: ClarificationQuestion[];
  busy?: boolean;
  onSubmit: (answers: ClarificationAnswer[]) => void;
}) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const complete = questions.length > 0 && questions.every((q) => (answers[q.ordinal] ?? '').trim().length > 0);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!complete || busy) return;
        onSubmit(questions.map((q) => ({ ordinal: q.ordinal, answer: (answers[q.ordinal] ?? '').trim() })));
      }}
    >
      <div className="space-y-2">
        {questions.map((q) => (
          <div key={q.ordinal} className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/30 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Question {q.ordinal}</p>
            <p className="text-sm font-medium text-zinc-200">{q.question}</p>
            <TextField
              label={`Answer to question ${q.ordinal}`}
              value={answers[q.ordinal] ?? ''}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.ordinal]: e.target.value }))}
              maxLength={5000}
              disabled={busy}
            />
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-zinc-500">All answers are sent together; every question needs an answer.</p>
        <button
          type="submit"
          data-testid="clarifications-submit"
          disabled={!complete || busy}
          className="shrink-0 cursor-pointer rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-emerald-900/20 transition-all hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? 'Sending…' : 'Send answers'}
        </button>
      </div>
    </form>
  );
}
