// apps/ui/src/components/code/code-editor.tsx
import { useEffect, useRef, useState } from 'react';
import { loadMonaco, monacoTheme, type MonacoApi } from '../../lib/monaco.ts';

type Editor = ReturnType<MonacoApi['editor']['create']>;

export interface CodeEditorProps {
  path: string;
  value: string;
  language: string;
  readOnly: boolean;
  dark: boolean;
  revealLine?: number | null;
  /** Bumped when the parent reloads the file from disk; the only time `value` is forced in. */
  resetToken?: number;
  onChange(value: string): void;
  onSave(): void;
}

export function CodeEditor({ path, value, language, readOnly, dark, revealLine, resetToken, onChange, onSave }: CodeEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const valueRef = useRef(value);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  valueRef.current = value;

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(null);
    void loadMonaco().then(
      (monaco) => {
        if (cancelled || !host.current) return;
        monacoRef.current = monaco;
        // Own the model explicitly: the standalone editor otherwise disposes an implicitly
        // created model itself, and our cleanup would dispose it a second time.
        const model = monaco.editor.createModel(valueRef.current, language);
        const editor = monaco.editor.create(host.current, {
          model,
          theme: monacoTheme(dark),
          readOnly,
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 13,
          lineHeight: 20,
          scrollBeyondLastLine: false,
          renderWhitespace: 'selection',
          tabSize: 2,
          padding: { top: 8 },
          ariaLabel: 'Code editor',
        });
        editor.onDidChangeModelContent(() => onChangeRef.current(editor.getModel()?.getValue(undefined, true) ?? ''));
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
        editorRef.current = editor;
        // Monaco normalizes mixed EOLs and may strip a BOM on construction. Baseline the parent
        // against what the editor will actually save so undo-to-original is not falsely dirty.
        const initial = editor.getModel()?.getValue(undefined, true) ?? '';
        if (initial !== valueRef.current) onChangeRef.current(initial);
        setReady(true);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
      const editor = editorRef.current;
      editorRef.current = null;
      if (editor) {
        const model = editor.getModel();
        editor.dispose();
        model?.dispose();
      }
    };
    // The editor is rebuilt only when the file changes; value/readOnly/theme are synced below.
  }, [path]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // Parent state can trail Monaco by a render; forcing it back would scramble fast typing.
    // `value` is authoritative only on an explicit reload (or when the path remounts us).
    if ((editor.getModel()?.getValue(undefined, true) ?? '') === value) return;
    const position = editor.getPosition();
    const scrollTop = editor.getScrollTop();
    editor.setValue(value);
    if (position) editor.setPosition(position);
    editor.setScrollTop(scrollTop);
  }, [resetToken]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly, ready]);

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    monaco.editor.setTheme(monacoTheme(dark));
  }, [dark, ready]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || revealLine == null) return;
    const line = Math.min(Math.max(1, revealLine), Math.max(1, editor.getModel()?.getLineCount() ?? 1));
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  }, [revealLine, ready, path]);

  return (
    <div className="relative h-full w-full" data-testid="code-editor" aria-busy={!ready && error === null}>
      {!ready && error === null && <p className="absolute inset-0 grid place-items-center text-xs text-muted">Loading editor…</p>}
      {error && <p role="alert" className="absolute inset-0 grid place-items-center p-4 text-center text-xs text-danger-foreground">Editor failed to load: {error}</p>}
      <div ref={host} className="h-full w-full" />
    </div>
  );
}
