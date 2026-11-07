import { describe, expect, it } from 'vitest';
import { createRedactor } from '../src/secrets/redactor.ts';

describe('redactor patterns', () => {
  const r = createRedactor();
  it.each([
    ['GitHub user token', `token ghu_${'a'.repeat(36)} end`, 'token [REDACTED:github-token] end'],
    ['GitHub refresh token', `ghr_${'B'.repeat(76)}`, '[REDACTED:github-token]'],
    ['GitHub classic PAT', `ghp_${'c'.repeat(36)}`, '[REDACTED:github-token]'],
    ['GitHub fine-grained PAT', `github_pat_${'d'.repeat(82)}`, '[REDACTED:github-token]'],
    ['OpenAI-style key', `key=sk-proj-${'e'.repeat(40)}`, 'key=[REDACTED:api-key]'],
    ['Google API key', `AIza${'f'.repeat(35)}`, '[REDACTED:api-key]'],
    ['Authorization header', 'Authorization: Bearer abc.def.ghi', 'Authorization: [REDACTED]'],
    ['Proxy basic auth', 'proxy-authorization: Basic dXNlcjpwYXNz', 'proxy-authorization: [REDACTED]'],
    ['URL credentials', 'clone https://user:s3cret@github.com/o/r.git', 'clone https://[REDACTED]@github.com/o/r.git'],
    ['PEM private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----', '[REDACTED:private-key]'],
  ])('%s', (_name, input, expected) => {
    expect(r.redact(input)).toBe(expected);
  });

  it('leaves ordinary text alone', () => {
    expect(r.redact('commit 1a2b3c on main; authorization required')).toBe('commit 1a2b3c on main; authorization required');
  });

  it('keeps JSON parseable when redacting an authorization field', () => {
    const line = JSON.stringify({ msg: 'req', authorization: 'Bearer abc123' });
    expect(JSON.parse(r.redact(line))).toEqual({ msg: 'req', authorization: '[REDACTED]' });
  });
});

describe('redactor extended patterns', () => {
  const r = createRedactor();
  const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;

  it.each([
    ['JWT', `session ${jwt} ok`, 'session [REDACTED:jwt] ok'],
    ['x-api-key header', 'x-api-key: abc123def', 'x-api-key: [REDACTED]'],
    ['api-key header', 'API-KEY = abc123', 'API-KEY = [REDACTED]'],
    ['apikey header', 'apikey=abc123', 'apikey=[REDACTED]'],
    ['set-cookie header', 'Set-Cookie: a=1; b=2', 'Set-Cookie: [REDACTED]'],
    ['cookie header', 'Cookie: a=1; b=2', 'Cookie: [REDACTED]'],
    ['postgres URL', 'postgres://user:p%40ss@db.example.com:5432/app', 'postgres://[REDACTED]@db.example.com:5432/app'],
    ['postgresql URL', 'postgresql://u:p@h/db', 'postgresql://[REDACTED]@h/db'],
    ['mysql URL', 'mysql://u:p@h/db', 'mysql://[REDACTED]@h/db'],
    ['mariadb URL', 'mariadb://u:p@h/db', 'mariadb://[REDACTED]@h/db'],
    ['redis URL', 'redis://u:p@h:6379', 'redis://[REDACTED]@h:6379'],
    ['rediss URL', 'rediss://u:p@h:6379', 'rediss://[REDACTED]@h:6379'],
    ['mongodb URL', 'mongodb://u:p@h/db', 'mongodb://[REDACTED]@h/db'],
    ['mongodb+srv URL', 'mongodb+srv://u:p@cluster.example.net/db', 'mongodb+srv://[REDACTED]@cluster.example.net/db'],
    ['amqp URL', 'amqp://u:p@h:5672', 'amqp://[REDACTED]@h:5672'],
    ['amqps URL', 'amqps://u:p@h:5672', 'amqps://[REDACTED]@h:5672'],
    ['npm token', `npm_${'d'.repeat(36)}`, '[REDACTED:npm-token]'],
    ['GitLab token', `glpat-${'e'.repeat(20)}`, '[REDACTED:gitlab-token]'],
    ['Hugging Face token', `hf_${'f'.repeat(30)}`, '[REDACTED:huggingface-token]'],
  ])('%s', (_name, input, expected) => {
    expect(r.redact(input)).toBe(expected);
  });

  it.each([
    ['two-segment JWT', `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}`],
    ['short JWT segment', `eyJ${'a'.repeat(20)}.${'b'.repeat(5)}.${'c'.repeat(20)}`],
    ['JWT whose header does not start with eyJ', `${'x'.repeat(23)}.${'b'.repeat(20)}.${'c'.repeat(20)}`],
    ['api-key header without a value', 'x-api-key:'],
    ['cookie prose', 'The cookie banner asks for consent before storing data.'],
    ['token prose', 'The token budget for this request is exhausted.'],
    ['database URL without userinfo', 'postgres://localhost:5432/app'],
    ['short npm token', `npm_${'d'.repeat(35)}`],
    ['short GitLab token', `glpat-${'e'.repeat(19)}`],
    ['short Hugging Face token', `hf_${'f'.repeat(29)}`],
  ])('leaves %s alone', (_name, input) => {
    expect(r.redact(input)).toBe(input);
  });

  it('is idempotent and keeps every new label', () => {
    const input = [
      `jwt ${jwt}`,
      'x-api-key: abc123',
      'Cookie: a=1; b=2',
      'postgres://user:pass@host/db',
      `npm_${'d'.repeat(36)}`,
      `glpat-${'e'.repeat(20)}`,
      `hf_${'f'.repeat(30)}`,
    ].join('\n');
    const once = r.redact(input);
    expect(once).toContain('[REDACTED:jwt]');
    expect(once).toContain('x-api-key: [REDACTED]');
    expect(once).toContain('Cookie: [REDACTED]');
    expect(once).toContain('postgres://[REDACTED]@host/db');
    expect(once).toContain('[REDACTED:npm-token]');
    expect(once).toContain('[REDACTED:gitlab-token]');
    expect(once).toContain('[REDACTED:huggingface-token]');
    expect(r.redact(once)).toBe(once);
  });
});

describe('redactor live secrets', () => {
  it('redacts registered secrets, including their JSON-escaped form', () => {
    const r = createRedactor();
    const secret = 'pa"ss\\word-12345';
    r.addSecret(secret);
    expect(r.redact(`value ${secret} here`)).toBe('value [REDACTED:secret] here');
    expect(r.redact(JSON.stringify({ x: secret }))).toBe('{"x":"[REDACTED:secret]"}');
  });
  it('ignores very short values and can forget secrets', () => {
    const r = createRedactor();
    r.addSecret('short');
    expect(r.redact('a short note')).toBe('a short note');
    r.addSecret('long-enough-secret');
    r.removeSecret('long-enough-secret');
    expect(r.redact('long-enough-secret')).toBe('long-enough-secret');
  });
});

describe('redactor credential-token rule (R12)', () => {
  const r = createRedactor();

  it('redacts raw access/refresh/id token JSON values, one-character values included', () => {
    const input = '{"tokens":{"access_token":"eyJhbGciOiJIUzI1NiJ9.payload.sig","refresh_token":"rt-refreshtoken-1","id_token":"x"}}';
    expect(r.redact(input)).toBe('{"tokens":{"access_token":"[REDACTED]","refresh_token":"[REDACTED]","id_token":"[REDACTED]"}}');
  });

  it('keeps the surrounding JSON parseable with its structure intact', () => {
    const input = JSON.stringify({ path: '/home/u/.codex/auth.json', tokens: { access_token: 'eyJaa.bb.ccdd', refresh_token: 'rt-zz', id_token: 'q' } });
    expect(JSON.parse(r.redact(input))).toEqual({
      path: '/home/u/.codex/auth.json',
      tokens: { access_token: '[REDACTED]', refresh_token: '[REDACTED]', id_token: '[REDACTED]' },
    });
  });

  it('tolerates spaces around the colon', () => {
    expect(r.redact('{"id_token" : "x"}')).toBe('{"id_token" : "[REDACTED]"}');
  });

  it('redacts the tokens JSON escaped inside a tool-output string, preserving the escaped quotes', () => {
    const inner = 'tool output: {\\"tokens\\":{\\"access_token\\":\\"eyJhbGci.payload.sig\\",\\"refresh_token\\":\\"rt-1\\",\\"id_token\\":\\"x\\"}} end';
    const expected = 'tool output: {\\"tokens\\":{\\"access_token\\":\\"[REDACTED]\\",\\"refresh_token\\":\\"[REDACTED]\\",\\"id_token\\":\\"[REDACTED]\\"}} end';
    expect(r.redact(inner)).toBe(expected);
  });

  it('ends an escaped value at its own closing quote and leaves following keys intact', () => {
    const inner = 'log {\\"access_token\\":\\"eyJaa\\",\\"session_id\\":\\"abc\\"}';
    expect(r.redact(inner)).toBe('log {\\"access_token\\":\\"[REDACTED]\\",\\"session_id\\":\\"abc\\"}');
  });

  it('an empty escaped value does not swallow the following token key (single escape depth)', () => {
    const inner = '{\\"id_token\\":\\"\\",\\"refresh_token\\":\\"rt-LEAKME-123\\"}';
    expect(r.redact(inner)).toBe('{\\"id_token\\":\\"\\",\\"refresh_token\\":\\"[REDACTED]\\"}');
  });

  it('an empty escaped value does not swallow the following token key (double escape depth)', () => {
    const leaf = '{\\"id_token\\":\\"\\",\\"refresh_token\\":\\"rt-LEAKME-123\\"}';
    const line = JSON.stringify({ output: leaf });
    const redacted = r.redact(line);
    expect(redacted).not.toContain('rt-LEAKME-123');
    expect(JSON.parse(redacted)).toEqual({ output: '{\\"id_token\\":\\"\\",\\"refresh_token\\":\\"[REDACTED]\\"}' });
  });

  it('redacts camelCase token keys as they appear in ~/.claude/.credentials.json', () => {
    const input = JSON.stringify({ credentials: { accessToken: 'opaque-camel-token', refreshToken: 'rt-camel', idToken: 'z' } });
    expect(JSON.parse(r.redact(input))).toEqual({ credentials: { accessToken: '[REDACTED]', refreshToken: '[REDACTED]', idToken: '[REDACTED]' } });
  });

  it('keeps an outer JSON line parseable when escaped tokens sit inside a string value', () => {
    const line = JSON.stringify({ output: 'read {\\"access_token\\":\\"eyJaa\\"} done' });
    expect(JSON.parse(r.redact(line))).toEqual({ output: 'read {\\"access_token\\":\\"[REDACTED]\\"} done' });
  });

  it('leaves non-credential JSON, empty values and bare field names alone', () => {
    expect(r.redact('{"note":"access_token is a field name"}')).toBe('{"note":"access_token is a field name"}');
    expect(r.redact('{"id_token":""}')).toBe('{"id_token":""}');
    expect(r.redact('access_token=abc12345')).toBe('access_token=abc12345');
    expect(r.redact('{"user":{"name":"ada","count":2}}')).toBe('{"user":{"name":"ada","count":2}}');
  });

  it('is idempotent in both the raw and the escaped form', () => {
    const raw = r.redact('{"tokens":{"access_token":"eyJaa","refresh_token":"rt-1","id_token":"x"}}');
    expect(r.redact(raw)).toBe(raw);
    const escaped = r.redact('{\\"access_token\\":\\"eyJaa\\"}');
    expect(r.redact(escaped)).toBe(escaped);
  });
});
