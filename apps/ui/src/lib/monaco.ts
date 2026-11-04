// apps/ui/src/lib/monaco.ts
import type * as Monaco from 'monaco-editor';

export type MonacoApi = typeof Monaco;

let pending: Promise<MonacoApi> | null = null;

interface MonacoEnvironmentShape {
  getWorker(workerId: string, label: string): Worker;
}

/**
 * Loads Monaco on demand. `editor.main` (not `editor.api`) carries the language tokenizers and
 * the bundled language-service registrations; importing this module only happens after the user
 * opens a file, so Monaco and its workers stay out of the initial bundle.
 *
 * Workers are Vite `?worker` bundles served from `app://ui/assets`; the renderer CSP allows
 * `worker-src 'self' blob:`. No CDN or `@monaco-editor/react` loader is involved.
 */
export function loadMonaco(): Promise<MonacoApi> {
  if (pending === null) {
    pending = (async () => {
      const [{ default: editorWorker }, { default: cssWorker }, { default: htmlWorker }, { default: jsonWorker }, { default: tsWorker }] =
        await Promise.all([
          import('monaco-editor/editor/editor.worker?worker'),
          import('monaco-editor/language/css/css.worker?worker'),
          import('monaco-editor/language/html/html.worker?worker'),
          import('monaco-editor/language/json/json.worker?worker'),
          import('monaco-editor/language/typescript/ts.worker?worker'),
        ]);
      (self as unknown as { MonacoEnvironment: MonacoEnvironmentShape }).MonacoEnvironment = {
        getWorker(_workerId: string, label: string): Worker {
          switch (label) {
            case 'json':
              return new jsonWorker();
            case 'css':
            case 'scss':
            case 'less':
              return new cssWorker();
            case 'html':
            case 'handlebars':
            case 'razor':
              return new htmlWorker();
            case 'typescript':
            case 'javascript':
              return new tsWorker();
            default:
              return new editorWorker();
          }
        },
      };
      return (await import('monaco-editor')) as MonacoApi;
    })().catch((err: unknown) => {
      // A transient chunk/worker failure must not poison every later attempt.
      pending = null;
      throw err;
    });
  }
  return pending;
}

/** Monaco's built-in themes are close enough to the app's Aurora light/dark pair. */
export function monacoTheme(dark: boolean): 'vs-dark' | 'vs' {
  return dark ? 'vs-dark' : 'vs';
}
