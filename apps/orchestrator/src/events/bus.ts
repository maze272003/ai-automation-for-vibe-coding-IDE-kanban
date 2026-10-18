import { EventEmitter } from 'node:events';

/** In-process notification that new outbox rows were committed. Consumers re-read the outbox (pull model). */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  notify(seq: number): void {
    this.emitter.emit('outbox', seq);
  }

  subscribe(fn: (seq: number) => void): () => void {
    this.emitter.on('outbox', fn);
    return () => this.emitter.off('outbox', fn);
  }
}
