// apps/orchestrator/src/git/credential-server.ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

interface NonceEntry {
  token: string;
  expiryUtc?: string;
  expiresAt: number;
  used: boolean;
}

export class GitCredentialServer {
  readonly pipePath: string;
  private server: net.Server | null = null;
  private readonly nonces = new Map<string, NonceEntry>();

  constructor(customPipePath?: string) {
    if (customPipePath) {
      this.pipePath = customPipePath;
    } else if (process.platform === 'win32') {
      this.pipePath = `\\\\.\\pipe\\aikanban-cred-${crypto.randomBytes(8).toString('hex')}`;
    } else {
      this.pipePath = path.join(os.tmpdir(), `aikanban-cred-${crypto.randomBytes(8).toString('hex')}.sock`);
    }
  }

  createNonce(token: string, expiryUtc?: string, ttlMs = 60_000): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    this.nonces.set(nonce, {
      token,
      expiryUtc,
      expiresAt: Date.now() + ttlMs,
      used: false,
    });
    return nonce;
  }

  async start(): Promise<void> {
    if (this.server) return;

    if (process.platform !== 'win32' && fs.existsSync(this.pipePath)) {
      try {
        fs.unlinkSync(this.pipePath);
      } catch {
        // Ignore if file could not be unlinked
      }
    }

    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        let buffer = '';
        let handled = false;

        const processRequest = () => {
          if (handled) return;
          try {
            const req = JSON.parse(buffer.trim());
            handled = true;
            const nonce = typeof req.nonce === 'string' ? req.nonce : '';
            const host = typeof req.host === 'string' ? req.host.toLowerCase() : '';

            const entry = this.nonces.get(nonce);
            const isValidHost = host === 'github.com' || host === 'api.github.com';
            const isValidNonce = entry !== undefined && !entry.used && Date.now() <= entry.expiresAt;

            if (isValidNonce && isValidHost) {
              entry.used = true;
              this.nonces.delete(nonce);
              socket.end(
                JSON.stringify({
                  ok: true,
                  password: entry.token,
                  username: 'x-access-token',
                  expiryUtc: entry.expiryUtc,
                }) + '\n'
              );
            } else {
              socket.end(JSON.stringify({ ok: false, error: 'unauthorized_or_expired' }) + '\n');
            }
          } catch {
            // Buffer might not be complete yet if multiple chunks
          }
        };

        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          if (buffer.includes('\n')) {
            processRequest();
          }
        });

        socket.on('end', () => {
          if (!handled) {
            processRequest();
          }
        });

        socket.on('error', () => {
          // Socket error, ignore
        });
      });

      server.on('error', reject);
      server.listen(this.pipePath, () => {
        this.server = server;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        if (process.platform !== 'win32' && fs.existsSync(this.pipePath)) {
          try {
            fs.unlinkSync(this.pipePath);
          } catch {
            // Ignore unlink error on close
          }
        }
        resolve();
      });
    });
  }
}
