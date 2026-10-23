// spikes/spk-6/probe.mjs — THROWAWAY automated escape & feasibility probe for MXC (REL-1).
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { getPlatformSupport, getAvailableBackends, run } from '@microsoft/mxc-sdk/v1';

const results = {
  timestamp: new Date().toISOString(),
  os: {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
  },
  probes: {},
};

console.log('=== Starting SPK-6 MXC Isolation Probe Suite ===\n');

// Helper to format results
function record(name, pass, details) {
  results.probes[name] = { pass, details };
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (details) console.log(`       Details: ${typeof details === 'object' ? JSON.stringify(details) : details}`);
}

// ----------------------------------------------------------------------------
// Probe 1: Platform Support & Unprivileged Container Creation
// ----------------------------------------------------------------------------
try {
  const support = getPlatformSupport();
  const backends = getAvailableBackends();
  const hasProcessContainer = backends.some((b) => b.backend === 'processcontainer');
  
  const testRun = await run({
    command: 'cmd.exe /c echo unprivileged_ok',
  });
  
  const ok = support.isSupported && hasProcessContainer && testRun.exitCode === 0 && testRun.stdout.includes('unprivileged_ok');
  record('probe1_unprivileged_creation', ok, {
    isSupported: support.isSupported,
    availableMethods: support.availableMethods,
    testExitCode: testRun.exitCode,
    stdout: testRun.stdout.trim(),
  });
} catch (err) {
  record('probe1_unprivileged_creation', false, { error: err.message });
}

// Setup temporary sandbox paths for filesystem tests
const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aik-spk6-sandbox-'));
const worktreeDir = path.join(sandboxRoot, 'worktree');
const outsideDir = path.join(sandboxRoot, 'outside');
fs.mkdirSync(worktreeDir, { recursive: true });
fs.mkdirSync(outsideDir, { recursive: true });

const canarySecretFile = path.join(outsideDir, 'canary-secret.txt');
fs.writeFileSync(canarySecretFile, 'TOP_SECRET_CANARY_DO_NOT_READ');

const userProfile = process.env.USERPROFILE || 'C:\\Users\\Default';
const userSshDir = path.join(userProfile, '.ssh');
const userOpencodeDir = path.join(userProfile, '.config', 'opencode');

// ----------------------------------------------------------------------------
// Probe 2: Filesystem Containment & Escape Suite
// ----------------------------------------------------------------------------
try {
  // 2a: Worktree write (must succeed)
  const writeRes = await run({
    command: `cmd.exe /c echo worktree_write_test > "${path.join(worktreeDir, 'test.txt')}"`,
    filesystem: {
      readwritePaths: [worktreeDir],
      deniedPaths: [outsideDir, userSshDir, userOpencodeDir],
    },
    process: { cwd: worktreeDir },
  });
  const fileExists = fs.existsSync(path.join(worktreeDir, 'test.txt'));
  record('probe2a_worktree_write', writeRes.exitCode === 0 && fileExists, {
    exitCode: writeRes.exitCode,
    fileExists,
  });

  // 2b: User profile secret access (must be denied)
  // Attempt to read the canary secret outside the worktree
  const canaryReadRes = await run({
    command: `cmd.exe /c type "${canarySecretFile}"`,
    filesystem: {
      readwritePaths: [worktreeDir],
      deniedPaths: [outsideDir, userSshDir, userOpencodeDir],
    },
    process: { cwd: worktreeDir },
  });
  const canaryDenied = canaryReadRes.exitCode !== 0 || !canaryReadRes.stdout.includes('TOP_SECRET_CANARY');
  record('probe2b_denied_paths_canary', canaryDenied, {
    exitCode: canaryReadRes.exitCode,
    denied: canaryDenied,
    stderr: canaryReadRes.stderr.trim(),
  });

  // 2c: User SSH directory read (must be denied)
  const sshReadRes = await run({
    command: `cmd.exe /c dir "${userSshDir}"`,
    filesystem: {
      readwritePaths: [worktreeDir],
      deniedPaths: [userSshDir, userOpencodeDir],
    },
    process: { cwd: worktreeDir },
  });
  const sshDenied = sshReadRes.exitCode !== 0 || sshReadRes.stderr.toLowerCase().includes('denied') || sshReadRes.stderr.toLowerCase().includes('cannot find');
  record('probe2c_user_profile_ssh_denied', sshDenied, {
    exitCode: sshReadRes.exitCode,
    denied: sshDenied,
    output: (sshReadRes.stdout + sshReadRes.stderr).trim().slice(0, 100),
  });

  // 2d: Path traversal attempt (must be denied)
  const traversalTarget = path.join(worktreeDir, '..', 'outside', 'canary-secret.txt');
  const traversalRes = await run({
    command: `cmd.exe /c type "${traversalTarget}"`,
    filesystem: {
      readwritePaths: [worktreeDir],
      deniedPaths: [outsideDir],
    },
    process: { cwd: worktreeDir },
  });
  const traversalBlocked = traversalRes.exitCode !== 0 || !traversalRes.stdout.includes('TOP_SECRET_CANARY');
  record('probe2d_path_traversal_blocked', traversalBlocked, {
    exitCode: traversalRes.exitCode,
    blocked: traversalBlocked,
  });
} catch (err) {
  record('probe2_filesystem_containment', false, { error: err.message });
}

// ----------------------------------------------------------------------------
// Probe 3: Windows Credential Manager Isolation
// ----------------------------------------------------------------------------
try {
  const credRes = await run({
    command: 'cmdkey.exe /list',
    processContainer: {
      ui: { isolation: 'container', desktopSystemControl: false, systemSettings: 'none', ime: false },
    },
  });
  // Inside container, cmdkey should either fail or return no generic credentials
  const credsIsolated = credRes.exitCode !== 0 || !credRes.stdout.includes('Target:');
  record('probe3_credential_manager_isolated', credsIsolated, {
    exitCode: credRes.exitCode,
    stdoutSnippet: credRes.stdout.trim().slice(0, 150),
    stderr: credRes.stderr.trim(),
  });
} catch (err) {
  record('probe3_credential_manager_isolated', false, { error: err.message });
}

// ----------------------------------------------------------------------------
// Probe 4: Network Egress & Loopback Isolation
// ----------------------------------------------------------------------------
let mockServer;
try {
  // Start local HTTP server to simulate AI Kanban model gateway
  const mockPort = await new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'gateway_ok' }));
    });
    mockServer.listen(0, '127.0.0.1', () => {
      resolve(mockServer.address().port);
    });
  });

  // 4a: Outbound egress deny (connect to public IP 1.1.1.1:80 must fail)
  const egressRes = await run({
    command: `node.exe -e "fetch('http://1.1.1.1', { signal: AbortSignal.timeout(2000) }).then(() => console.log('CONNECTED')).catch(e => { console.error('BLOCKED'); process.exit(1); })"`,
    network: {
      egress: { default: 'deny' },
      ingress: { hostLoopback: 'allow' },
    },
  });
  const egressBlocked = egressRes.exitCode !== 0 || !egressRes.stdout.includes('CONNECTED');
  record('probe4a_external_network_egress_denied', egressBlocked, {
    exitCode: egressRes.exitCode,
    blocked: egressBlocked,
  });

  // 4b: Loopback to model gateway allow
  const loopbackRes = await run({
    command: `node.exe -e "fetch('http://127.0.0.1:${mockPort}').then(r => r.json()).then(d => console.log(d.status)).catch(e => { console.error(e.message); process.exit(1); })"`,
    network: {
      egress: { default: 'deny' },
      ingress: { hostLoopback: 'allow' },
    },
  });
  const loopbackAllowed = loopbackRes.exitCode === 0 && loopbackRes.stdout.includes('gateway_ok');
  record('probe4b_loopback_gateway_allowed', loopbackAllowed, {
    exitCode: loopbackRes.exitCode,
    stdout: loopbackRes.stdout.trim(),
    stderr: loopbackRes.stderr.trim(),
  });
} catch (err) {
  record('probe4_network_isolation', false, { error: err.message });
} finally {
  if (mockServer) mockServer.close();
}

// ----------------------------------------------------------------------------
// Probe 5: Toolchain Usability (git, node in worktree)
// ----------------------------------------------------------------------------
try {
  const gitInitRes = await run({
    command: 'git.exe init -q -b main && git.exe config user.name "spk6" && git.exe config user.email "spk6@localhost"',
    filesystem: {
      readwritePaths: [worktreeDir],
    },
    process: { cwd: worktreeDir },
  });
  const gitStatusRes = await run({
    command: 'git.exe status',
    filesystem: {
      readwritePaths: [worktreeDir],
    },
    process: { cwd: worktreeDir },
  });
  const nodeVersionRes = await run({
    command: 'node.exe -v',
  });

  const toolchainsOk = gitInitRes.exitCode === 0 && gitStatusRes.exitCode === 0 && nodeVersionRes.exitCode === 0;
  record('probe5_toolchain_usability', toolchainsOk, {
    gitInitExit: gitInitRes.exitCode,
    gitStatusExit: gitStatusRes.exitCode,
    nodeVersion: nodeVersionRes.stdout.trim(),
  });
} catch (err) {
  record('probe5_toolchain_usability', false, { error: err.message });
}

// ----------------------------------------------------------------------------
// Probe 6: Latency Benchmarking
// ----------------------------------------------------------------------------
try {
  const t0 = performance.now();
  await run({ command: 'cmd.exe /c echo 1' });
  const coldMs = Math.round(performance.now() - t0);

  const t1 = performance.now();
  await run({ command: 'cmd.exe /c echo 2' });
  const warmMs = Math.round(performance.now() - t1);

  record('probe6_latency_benchmark', coldMs < 3000, {
    coldMs,
    warmMs,
  });
} catch (err) {
  record('probe6_latency_benchmark', false, { error: err.message });
}

// Cleanup
try {
  fs.rmSync(sandboxRoot, { recursive: true, force: true });
} catch {
  // ignore cleanup error
}

console.log('\n=== Probe Execution Complete ===\n');
const outDir = path.join(import.meta.dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
