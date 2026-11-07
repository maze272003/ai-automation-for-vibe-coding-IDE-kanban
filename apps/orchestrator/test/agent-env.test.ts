import { describe, expect, test } from 'vitest';
import { AGENT_ENV_ALLOWLIST, agentEnvironment, type AgentEnvRuntime } from '../src/process/agent-env.ts';

const BASE: NodeJS.ProcessEnv = {
  GITHUB_TOKEN: 'ghp_x',
  GH_TOKEN: 'gh_x',
  AIK_API_TOKEN: 'aik_x',
  OPENAI_API_KEY: 'sk-openai',
  ANTHROPIC_API_KEY: 'sk-ant',
  OPENCODE_SERVER_PASSWORD: 'pw',
  NODE_OPTIONS: '--require evil.js',
  SOME_RANDOM_VAR: 'r',
  PATH: 'C:\\bin',
  USERPROFILE: 'C:\\Users\\u',
  CODEX_HOME: 'C:\\Users\\u\\.codex',
  CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe',
  HTTPS_PROXY: 'http://proxy:8080',
  https_proxy: 'http://proxy:8080',
};

const GIT_KEYS = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
};

const ROOT = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex';

const sortedKeys = (env: NodeJS.ProcessEnv) => Object.keys(env).sort();

const ALL_RUNTIMES: AgentEnvRuntime[] = ['claude-code', 'codex', 'qa-ui', 'install', 'dev-server'];

describe('agentEnvironment', () => {
  test('codex: exactly the allowlisted keys present + the fixed keys', () => {
    const env = agentEnvironment(BASE, { runtime: 'codex', codexPackageRoot: ROOT });
    expect(sortedKeys(env)).toEqual(
      [
        'PATH',
        'USERPROFILE',
        'CODEX_HOME',
        'CLAUDE_CODE_GIT_BASH_PATH',
        'HTTPS_PROXY',
        'https_proxy',
        ...Object.keys(GIT_KEYS),
        'DISABLE_AUTOUPDATER',
        'CODEX_MANAGED_PACKAGE_ROOT',
        'CODEX_MANAGED_BY_NPM',
      ].sort(),
    );
    expect(env).toMatchObject({
      ...GIT_KEYS,
      PATH: 'C:\\bin',
      USERPROFILE: 'C:\\Users\\u',
      CODEX_HOME: 'C:\\Users\\u\\.codex',
      HTTPS_PROXY: 'http://proxy:8080',
      https_proxy: 'http://proxy:8080',
      DISABLE_AUTOUPDATER: '1',
      CODEX_MANAGED_PACKAGE_ROOT: ROOT,
      CODEX_MANAGED_BY_NPM: '1',
    });
  });

  test('claude: keeps CLAUDE_CODE_GIT_BASH_PATH and has no Codex package-root keys', () => {
    const env = agentEnvironment(BASE, { runtime: 'claude-code', codexPackageRoot: ROOT });
    expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe('C:\\Git\\bin\\bash.exe');
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
    expect(env).toMatchObject(GIT_KEYS);
    expect('CODEX_MANAGED_PACKAGE_ROOT' in env).toBe(false);
    expect('CODEX_MANAGED_BY_NPM' in env).toBe(false);
  });

  test('codex without a package root is refused instead of guessing', () => {
    expect(() => agentEnvironment(BASE, { runtime: 'codex' })).toThrow(/codexPackageRoot/);
    expect(() => agentEnvironment(BASE, { runtime: 'codex', codexPackageRoot: '' })).toThrow(/codexPackageRoot/);
  });

  test('qa-ui adds PLAYWRIGHT_BROWSERS_PATH only when present; other runtimes never', () => {
    const withPw = { ...BASE, PLAYWRIGHT_BROWSERS_PATH: 'C:\\pw' };
    expect(agentEnvironment(withPw, { runtime: 'qa-ui' }).PLAYWRIGHT_BROWSERS_PATH).toBe('C:\\pw');
    expect('PLAYWRIGHT_BROWSERS_PATH' in agentEnvironment(BASE, { runtime: 'qa-ui' })).toBe(false);
    for (const runtime of ['claude-code', 'codex', 'install', 'dev-server'] as const) {
      const env = agentEnvironment(withPw, { runtime, codexPackageRoot: ROOT });
      expect('PLAYWRIGHT_BROWSERS_PATH' in env).toBe(false);
    }
  });

  test('install and dev-server get the system/profile/network allowlist and fixed keys, but no CLI config locations', () => {
    const base = { ...BASE, CLAUDE_CONFIG_DIR: 'C:\\cfg' };
    for (const runtime of ['install', 'dev-server'] as const) {
      const env = agentEnvironment(base, { runtime });
      expect(sortedKeys(env)).toEqual(
        ['PATH', 'USERPROFILE', 'HTTPS_PROXY', 'https_proxy', ...Object.keys(GIT_KEYS), 'DISABLE_AUTOUPDATER'].sort(),
      );
    }
  });

  test('no option makes a provider key, GitHub token, AIK_* or unlisted variable appear', () => {
    const hostile = {
      ...BASE,
      GITHUB_ACTIONS: 'true',
      GH_ENTERPRISE_TOKEN: 'x',
      AIK_GATEWAY_TOKEN: 'x',
      AIK_OFFICE_TOKEN: 'x',
      aik_lower: 'x',
      anthropic_api_key: 'x',
      ANTHROPIC_AUTH_TOKEN: 'x',
      OPENAI_BASE_URL: 'x',
    };
    const forbidden = /^(ANTHROPIC|OPENAI|GITHUB|GH_|AIK|OPENCODE|NODE_OPTIONS|SOME_RANDOM_VAR)/i;
    for (const runtime of ALL_RUNTIMES) {
      for (const extra of [{}, { codexPackageRoot: ROOT }, { codexPackageRoot: ROOT, ANTHROPIC_API_KEY: 'x', passthrough: ['ANTHROPIC_API_KEY'] }]) {
        if (runtime === 'codex' && !('codexPackageRoot' in extra)) continue;
        const env = agentEnvironment(hostile, { runtime, ...extra } as Parameters<typeof agentEnvironment>[1]);
        expect(Object.keys(env).filter((k) => forbidden.test(k))).toEqual([]);
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      }
    }
  });

  test('the base env is never mutated and the result is a fresh object', () => {
    const base = { ...BASE };
    const snapshot = { ...base };
    const env = agentEnvironment(base, { runtime: 'claude-code' });
    expect(base).toEqual(snapshot);
    expect(env).not.toBe(base);
  });

  test('Windows key spelling is matched case-insensitively and kept as given (process.env uses "Path")', () => {
    const env = agentEnvironment(
      { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', windir: 'C:\\Windows', PathExt: '.EXE' },
      { runtime: 'claude-code' },
    );
    expect(env.Path).toBe('C:\\Windows');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.ComSpec).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(env.PathExt).toBe('.EXE');
  });

  test('inherited git config variables cannot override the fixed git hardening', () => {
    const env = agentEnvironment(
      { ...BASE, GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_1: 'core.sshCommand', GIT_CONFIG_VALUE_1: 'evil', GIT_ASKPASS: 'evil.exe', DISABLE_AUTOUPDATER: '0' },
      { runtime: 'claude-code' },
    );
    expect(env).toMatchObject({ ...GIT_KEYS, DISABLE_AUTOUPDATER: '1' });
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined();
    expect(env.GIT_ASKPASS).toBeUndefined();
  });

  test('undefined values are not copied', () => {
    const env = agentEnvironment({ PATH: 'C:\\bin', TEMP: undefined }, { runtime: 'claude-code' });
    expect('TEMP' in env).toBe(false);
  });

  test('the allowlist is exactly spec §6.2', () => {
    expect([...AGENT_ENV_ALLOWLIST.system]).toEqual([
      'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
      'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramW6432',
      'ALLUSERSPROFILE', 'PUBLIC', 'PSModulePath', 'SystemDrive',
    ]);
    expect([...AGENT_ENV_ALLOWLIST.profile]).toEqual([
      'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
    ]);
    expect([...AGENT_ENV_ALLOWLIST.network]).toEqual([
      'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
    ]);
    expect([...AGENT_ENV_ALLOWLIST.cli]).toEqual(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'CODEX_HOME']);
  });
});
