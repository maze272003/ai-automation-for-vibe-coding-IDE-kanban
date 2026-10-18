export interface Redactor {
  addSecret(value: string): void;
  removeSecret(value: string): void;
  redact(text: string): string;
}

type Rule = { re: RegExp; replace: (match: string, ...groups: string[]) => string };

const RULES: Rule[] = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replace: () => '[REDACTED:private-key]' },
  { re: /\bgh[oprsu]_[A-Za-z0-9]{36,}\b/g, replace: () => '[REDACTED:github-token]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, replace: () => '[REDACTED:github-token]' },
  { re: /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}\b/g, replace: () => '[REDACTED:api-key]' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => '[REDACTED:api-key]' },
  {
    re: /((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;}]+/gi,
    replace: (_m, prefix) => `${prefix}[REDACTED]`,
  },
  { re: /\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, replace: (_m, scheme) => `${scheme}[REDACTED]@` },
];

const MIN_SECRET_LENGTH = 8;
const jsonEscaped = (v: string): string => JSON.stringify(v).slice(1, -1);

export function createRedactor(): Redactor {
  const secrets = new Set<string>();
  return {
    addSecret(value) {
      if (value.length < MIN_SECRET_LENGTH) return;
      secrets.add(value);
      secrets.add(jsonEscaped(value));
    },
    removeSecret(value) {
      secrets.delete(value);
      secrets.delete(jsonEscaped(value));
    },
    redact(text) {
      let out = text;
      for (const s of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(s).join('[REDACTED:secret]');
      for (const rule of RULES) out = out.replace(rule.re, rule.replace);
      return out;
    },
  };
}
