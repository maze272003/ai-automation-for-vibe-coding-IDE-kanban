import { createSseParser } from '@aik/contracts';

export interface ForwarderOptions {
  getPort: () => number | null;
  token: string;
  send: (event: unknown) => void;
  initialRetryMs?: number;
  maxRetryMs?: number;
}

/** Consumes the orchestrator SSE stream in the main process and forwards events to the renderer. */
export class EventForwarder {
  private readonly opts: ForwarderOptions;
  private lastEventId: string | null = null;
  private controller: AbortController | null = null;
  private running = false;

  constructor(opts: ForwarderOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.controller?.abort();
  }

  private async loop(): Promise<void> {
    const initial = this.opts.initialRetryMs ?? 500;
    let retry = initial;
    while (this.running) {
      const port = this.opts.getPort();
      if (port !== null) {
        this.controller = new AbortController();
        try {
          const res = await fetch(`http://127.0.0.1:${port}/events`, {
            headers: { authorization: `Bearer ${this.opts.token}`, ...(this.lastEventId ? { 'last-event-id': this.lastEventId } : {}) },
            signal: this.controller.signal,
          });
          if (res.ok && res.body) {
            retry = initial;
            const parse = createSseParser((m) => {
              if (m.id !== null) this.lastEventId = m.id;
              try {
                this.opts.send(JSON.parse(m.data));
              } catch {
                /* ignore malformed event */
              }
            });
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              parse(decoder.decode(value, { stream: true }));
            }
          }
        } catch {
          /* connection dropped or aborted — reconnect below */
        }
      }
      if (!this.running) break;
      await new Promise((r) => setTimeout(r, retry));
      retry = Math.min(retry * 2, this.opts.maxRetryMs ?? 8000);
    }
  }
}
