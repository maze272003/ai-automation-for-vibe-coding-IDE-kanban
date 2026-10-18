import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EventForwarder } from '../src/main/events-forwarder.ts';

let server: http.Server | undefined;
afterEach(() => server?.close());

describe('EventForwarder', () => {
  it('forwards events, reconnects, and resumes with Last-Event-ID', async () => {
    const seenHeaders: (string | undefined)[] = [];
    const seenAuth: (string | undefined)[] = [];
    let connections = 0;
    server = http.createServer((req, res) => {
      connections += 1;
      seenHeaders.push(req.headers['last-event-id'] as string | undefined);
      seenAuth.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (connections === 1) {
        res.end('id: 1\ndata: {"seq":1}\n\nid: 2\ndata: {"seq":2}\n\n');
      } else {
        res.write('id: 3\ndata: {"seq":3}\n\n');
      }
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const received: unknown[] = [];
    const fwd = new EventForwarder({ getPort: () => port, token: 'tok', send: (e) => received.push(e), initialRetryMs: 10 });
    fwd.start();
    const t0 = Date.now();
    while (received.length < 3 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
    fwd.stop();
    expect(received).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    expect(seenHeaders.slice(0, 2)).toEqual([undefined, '2']);
    expect(seenAuth.every((a) => a === 'Bearer tok')).toBe(true);
  });
});
