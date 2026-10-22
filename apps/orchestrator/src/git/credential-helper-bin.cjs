#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
// apps/orchestrator/src/git/credential-helper-bin.cjs
// Minimal standalone Git Credential Helper implementing spec §13.4.
// Connects to the orchestrator's local named pipe to resolve credentials using a single-use nonce.

const net = require('node:net');

const op = process.argv[2];
if (op !== 'get') {
  process.exit(0);
}

const pipePath = process.env.AIKANBAN_CRED_PIPE;
const nonce = process.env.AIKANBAN_CRED_NONCE;

if (!pipePath || !nonce) {
  process.exit(0);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', () => {
  const fields = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      fields[key] = val;
    }
  }

  const socket = net.connect(pipePath, () => {
    socket.write(
      JSON.stringify({
        nonce,
        host: fields.host || '',
        protocol: fields.protocol || '',
      }) + '\n'
    );
  });

  let responseData = '';
  socket.on('data', (chunk) => {
    responseData += chunk.toString('utf8');
  });

  socket.on('end', () => {
    try {
      const res = JSON.parse(responseData || '{}');
      if (res && res.ok && res.password) {
        const username = res.username || 'x-access-token';
        process.stdout.write(`username=${username}\npassword=${res.password}\n`);
        if (res.expiryUtc) {
          process.stdout.write(`password_expiry_utc=${res.expiryUtc}\n`);
        }
        process.stdout.write('quit=1\n');
      }
    } catch {
      // Ignore parse errors, exit cleanly
    }
    process.exit(0);
  });

  socket.on('error', () => {
    process.exit(0);
  });
});
