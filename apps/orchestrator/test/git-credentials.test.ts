import net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitCredentialServer } from '../src/git/credential-server.ts';

function queryHelper(pipePath: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = net.connect(pipePath, () => {
      client.write(JSON.stringify(payload) + '\n');
    });
    let data = '';
    client.on('data', (d) => {
      data += d.toString('utf8');
    });
    client.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        resolve({ parseError: err, rawData: data });
      }
    });
    client.on('error', reject);
  });
}

describe('GitCredentialServer', () => {
  it('serves credentials when nonce and host match', async () => {
    const server = new GitCredentialServer();
    await server.start();
    try {
      const nonce = server.createNonce('gho_test_token_123', '2026-10-23T04:00:00Z');
      const res = await queryHelper(server.pipePath, { nonce, host: 'github.com', protocol: 'https' });
      expect(res.ok).toBe(true);
      expect(res.password).toBe('gho_test_token_123');
      expect(res.username).toBe('x-access-token');
      expect(res.expiryUtc).toBe('2026-10-23T04:00:00Z');
    } finally {
      await server.close();
    }
  });

  it('rejects nonce reuse (single-use enforcement)', async () => {
    const server = new GitCredentialServer();
    await server.start();
    try {
      const nonce = server.createNonce('gho_test_token_456');
      const first = await queryHelper(server.pipePath, { nonce, host: 'github.com' });
      expect(first.ok).toBe(true);

      const second = await queryHelper(server.pipePath, { nonce, host: 'github.com' });
      expect(second.ok).toBe(false);
      expect(second.password).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('rejects expired nonces', async () => {
    const server = new GitCredentialServer();
    await server.start();
    try {
      // Create nonce with -1 TTL (already expired)
      const nonce = server.createNonce('gho_test_token_789', undefined, -1);
      const res = await queryHelper(server.pipePath, { nonce, host: 'github.com' });
      expect(res.ok).toBe(false);
      expect(res.password).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('rejects non-github.com hosts', async () => {
    const server = new GitCredentialServer();
    await server.start();
    try {
      const nonce = server.createNonce('gho_test_token_sec');
      const res = await queryHelper(server.pipePath, { nonce, host: 'evil-phishing.com' });
      expect(res.ok).toBe(false);
      expect(res.password).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('helper binary responds to stdin in git credential format', async () => {
    const server = new GitCredentialServer();
    await server.start();
    try {
      const nonce = server.createNonce('gho_mock_token_for_cli');
      const helperPath = path.resolve(__dirname, '../src/git/credential-helper-bin.cjs');

      const { execFile } = await import('node:child_process');
      const output = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          [helperPath, 'get'],
          {
            env: {
              ...process.env,
              AIKANBAN_CRED_PIPE: server.pipePath,
              AIKANBAN_CRED_NONCE: nonce,
            },
          },
          (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          },
        );
        child.stdin?.write('protocol=https\nhost=github.com\n\n');
        child.stdin?.end();
      });

      expect(output).toContain('username=x-access-token');
      expect(output).toContain('password=gho_mock_token_for_cli');
      expect(output).toContain('quit=1');
    } finally {
      await server.close();
    }
  });

  it('helper binary exits cleanly with no output when called with store or erase', async () => {
    const helperPath = path.resolve(__dirname, '../src/git/credential-helper-bin.cjs');
    const { execFile } = await import('node:child_process');
    const output = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [helperPath, 'store'], (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
    expect(output).toBe('');
  });

  it('gitWithCredentials configures git to obtain credentials via helper', async () => {
    const { gitWithCredentials, getSharedCredentialServer, closeSharedCredentialServer } = await import('../src/git/git.ts');
    const server = await getSharedCredentialServer();
    try {
      const output = await gitWithCredentials(
        ['credential', 'fill'],
        {
          cwd: process.cwd(),
          token: 'gho_integrated_token_999',
          input: 'protocol=https\nhost=github.com\n\n',
          credentialServer: server,
        }
      );
      expect(output).toContain('username=x-access-token');
      expect(output).toContain('password=gho_integrated_token_999');
    } finally {
      await closeSharedCredentialServer();
    }
  });

  it('agent and check environment gets no credentials (spec §13.4)', async () => {
    const { git } = await import('../src/git/git.ts');
    // Calling git credential fill with normal git() (which disables credential helper)
    // should yield empty output / not authenticate
    const res = await git(['credential', 'fill'], {
      cwd: process.cwd(),
    }).catch((err) => err.stderr || err.message);

    expect(res).not.toContain('password=');
  });
});

