const ALLOWED_HOSTS = new Set(['github.com', 'docs.github.com', 'opencode.ai', 'ollama.com', 'openrouter.ai', 'developers.cloudflare.com']);

/** External links open in the OS browser only for allowlisted HTTPS hosts without credentials. */
export function isAllowedExternal(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname) && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}
