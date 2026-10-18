// apps/orchestrator/src/main.ts
// Entry point inside an Electron utilityProcess. Speaks a tiny message protocol with the main process.
import { DatabaseCorruptError } from '@aik/db';
import { startOrchestrator, type OrchestratorOptions, type RunningOrchestrator } from './app.ts';

type InitMessage = { type: 'init' } & OrchestratorOptions;
type InboundMessage = InitMessage | { type: 'shutdown' };
interface ParentPort {
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  console.error('The orchestrator must run inside an Electron utilityProcess');
  process.exit(2);
}

let running: RunningOrchestrator | null = null;

parentPort.on('message', ({ data }) => {
  const msg = data as InboundMessage;
  if (msg.type === 'init' && running === null) {
    if (process.env.AIK_E2E === '1' && process.env.AIK_TEST_CRASH_ORCHESTRATOR === '1') process.exit(1);
    startOrchestrator(msg).then(
      (r) => {
        running = r;
        parentPort.postMessage({ type: 'ready', port: r.port });
      },
      (err: unknown) => {
        parentPort.postMessage({
          type: 'fatal',
          kind: err instanceof DatabaseCorruptError ? 'database_corrupt' : 'startup_failed',
          message: err instanceof Error ? err.message : String(err),
        });
        process.exit(3);
      },
    );
  } else if (msg.type === 'shutdown') {
    void (running?.close() ?? Promise.resolve()).finally(() => process.exit(0));
  }
});
