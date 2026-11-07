// apps/orchestrator/src/agents/runtimes/jsonl.ts — UTF-8 safe JSONL decoder for CLI stdout
// (spec §5.3, task 6.1a-04). Only stdout is ever pushed here; stderr is captured elsewhere and
// never parsed as frames. An oversized line is reported once with a fixed marker (never its
// content) and dropped, so a runaway CLI cannot OOM the orchestrator with one huge line. Each
// chunk is scanned and byte-counted exactly once (running counters), keeping a small-chunk CLI
// near the cap linear instead of quadratic on the event loop.
import { StringDecoder } from 'node:string_decoder';

export interface JsonlDecoder {
  push(chunk: Buffer): void;
  end(): void;
}

/** Per-line cap in bytes; a longer line is reported malformed once and then dropped. */
export const JSONL_MAX_LINE_BYTES = 1024 * 1024;

/** Passed to onMalformed instead of the oversized line, so the marker never echoes line content. */
export const JSONL_OVERSIZE_MARKER = '[aik:jsonl-line-over-1mib]';

export function createJsonlDecoder(
  onFrame: (frame: unknown) => void,
  /** Receives the RAW, UNREDACTED line: persist it only through `createRunLog().appendDiagnostic`
   *  (which redacts) — or redact it first. Task 6.1a-06's malformed-frame counter depends on this. */
  onMalformed: (line: string) => void,
): JsonlDecoder {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let pendingBytes = 0; // running byte length of `pending` (the cap is counted in bytes)
  let scanned = 0; // chars of `pending` already searched for '\n'
  let dropping = false;
  let ended = false;

  const handleLine = (line: string): void => {
    if (line.endsWith('\r')) line = line.slice(0, -1); // \r\n tolerant
    if (line === '') return; // empty lines are skipped, not malformed
    if (Buffer.byteLength(line, 'utf8') > JSONL_MAX_LINE_BYTES) {
      onMalformed(JSONL_OVERSIZE_MARKER);
      return;
    }
    try {
      onFrame(JSON.parse(line));
    } catch {
      onMalformed(line);
    }
  };

  const takeCompleteLines = (): void => {
    for (;;) {
      const nl = pending.indexOf('\n', scanned);
      if (nl < 0) {
        scanned = pending.length;
        return;
      }
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      pendingBytes -= Buffer.byteLength(line, 'utf8') + 1;
      scanned = 0; // the text after the extracted newline was never scanned
      handleLine(line);
    }
  };

  return {
    push(chunk) {
      if (ended) return;
      const text = decoder.write(chunk);
      if (dropping) {
        const nl = text.indexOf('\n');
        if (nl < 0) return; // still inside the dropped oversized line
        pending = text.slice(nl + 1);
        pendingBytes = Buffer.byteLength(pending, 'utf8');
        scanned = 0;
        dropping = false;
      } else {
        pending += text;
        pendingBytes += Buffer.byteLength(text, 'utf8');
      }
      takeCompleteLines();
      if (!dropping && pendingBytes > JSONL_MAX_LINE_BYTES) {
        onMalformed(JSONL_OVERSIZE_MARKER);
        pending = '';
        pendingBytes = 0;
        scanned = 0;
        dropping = true; // discard the rest of this line instead of buffering it
      }
    },
    end() {
      if (ended) return;
      ended = true;
      if (dropping) return; // the oversized line's marker was already reported
      const tail = decoder.end();
      pending += tail;
      pendingBytes += Buffer.byteLength(tail, 'utf8');
      takeCompleteLines();
      if (pending !== '') handleLine(pending); // a final line without a newline is flushed
      pending = '';
      pendingBytes = 0;
      scanned = 0;
    },
  };
}
