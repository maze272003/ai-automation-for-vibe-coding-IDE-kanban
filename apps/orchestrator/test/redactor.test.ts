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
