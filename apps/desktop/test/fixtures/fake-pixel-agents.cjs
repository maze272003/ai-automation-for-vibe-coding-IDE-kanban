// apps/desktop/test/fixtures/fake-pixel-agents.cjs
/* eslint-disable @typescript-eslint/no-require-imports */
// Minimal stand-in for the pixel-agents CLI: serves /api/health on an ephemeral port and
// writes the registry entry pixel-agents would write, honouring AIK_OFFICE_REGISTRY_DIR.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

// The launcher must pass ELECTRON_RUN_AS_NODE=1: in the Electron main process
// process.execPath is the Electron binary, and without the flag the "CLI" run is a
// second Electron app that never starts the server (the original no-pixel bug).
// Requiring it here turns the spawn test into a regression test for that contract.
if (process.env.ELECTRON_RUN_AS_NODE !== '1') process.exit(2);

const dir = process.env.AIK_OFFICE_REGISTRY_DIR;
if (!dir) process.exit(2);

const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const entry = {
    port,
    pid: process.pid,
    token: 'test-office-token-1234567890',
    startedAt: Date.now(),
    servesSpa: true,
    protocol: 1,
  };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${process.pid}-${port}.json`);
  fs.writeFileSync(file, JSON.stringify(entry, null, 2));
});
