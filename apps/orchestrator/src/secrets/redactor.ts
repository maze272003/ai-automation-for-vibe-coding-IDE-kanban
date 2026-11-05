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
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => '[REDACTED:aws-key]' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: () => '[REDACTED:slack-token]' },
  {
    re: /((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;}]+/gi,
    replace: (_m, prefix) => `${prefix}[REDACTED]`,
  },
  { re: /\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, replace: (_m, scheme) => `${scheme}[REDACTED]@` },
  // JWT: header.payload.signature, base64url, at least 10 chars per segment; header starts eyJ.
  {
    re: /\beyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/g,
    replace: () => '[REDACTED:jwt]',
  },
  // API-key header values: x-api-key / api-key / apikey, case-insensitive, prefix preserved.
  {
    re: /\b((?:x-api-key|api-key|apikey)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
    replace: (_m, prefix) => `${prefix}[REDACTED]`,
  },
  // Cookie header values: cookie / set-cookie, case-insensitive, prefix preserved.
  {
    re: /\b((?:set-cookie|cookie)["']?\s*[:=]\s*["']?)[^\r\n"']+/gi,
    replace: (_m, prefix) => `${prefix}[REDACTED]`,
  },
  // Database URL userinfo (postgres/postgresql/mysql/mariadb/redis/rediss/mongodb(+srv)/amqp/amqps).
  {
    re: /\b((?:postgres(?:ql)?|mysql|mariadb|redis(?:s)?|mongodb(?:\+srv)?|amqps?):\/\/)[^\s/@]+@/gi,
    replace: (_m, scheme) => `${scheme}[REDACTED]@`,
  },
  { re: /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g, replace: () => '[REDACTED:npm-token]' },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g, replace: () => '[REDACTED:gitlab-token]' },
  { re: /\bhf_[A-Za-z0-9]{30,}(?![A-Za-z0-9])/g, replace: () => '[REDACTED:huggingface-token]' },
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
