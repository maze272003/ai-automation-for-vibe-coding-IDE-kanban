// apps/desktop/test/fixtures/slow-pixel-agents.cjs
/* eslint-disable @typescript-eslint/no-require-imports */
// Like fake-pixel-agents.cjs but delays its registry write, so a test can call
// stopOfficeServer() while startOfficeServer() is still launching.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

if (process.env.ELECTRON_RUN_AS_NODE !== '1') process.exit(2);
const dir = process.env.AIK_OFFICE_REGISTRY_DIR;
if (!dir) process.exit(2);

setTimeout(() => {
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
    const entry = { port, pid: process.pid, token: 'test-office-token-1234567890', startedAt: Date.now(), servesSpa: true, protocol: 1 };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${process.pid}-${port}.json`), JSON.stringify(entry, null, 2));
  });
}, 400);
