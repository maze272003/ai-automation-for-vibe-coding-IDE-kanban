// apps/orchestrator/src/git/status-parse.ts
/** Parsed `git status --porcelain=v1 -z --branch`. */
export interface ParsedStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  files: { path: string; x: string; y: string }[];
}

const AHEAD = /ahead (\d+)/;
const BEHIND = /behind (\d+)/;

export function parsePorcelainStatus(out: string): ParsedStatus {
  const fields = out.split('\0').filter((f) => f !== '');
  const s: ParsedStatus = { branch: null, upstream: null, ahead: null, behind: null, files: [] };
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.startsWith('## ')) {
      const rest = f.slice(3);
      const bracket = rest.indexOf('[');
      const header = bracket === -1 ? rest : rest.slice(0, bracket).trim();
      const m = AHEAD.exec(rest);
      s.ahead = m ? Number(m[1]) : null;
      const b = BEHIND.exec(rest);
      s.behind = b ? Number(b[1]) : null;
      const dd = header.indexOf('...');
      if (header === 'HEAD (no branch)') {
        s.branch = null;
        s.upstream = null;
      } else if (dd !== -1) {
        s.branch = header.slice(0, dd);
        s.upstream = header.slice(dd + 3);
      } else {
        s.branch = header;
        s.upstream = null;
      }
      continue;
    }
    const x = f[0] ?? ' ';
    const y = f[1] ?? ' ';
    if (x === 'R' || y === 'R' || x === 'C') i++; // next field holds the original path; keep the NEW path
    const p = f.slice(3);
    if (p !== '') s.files.push({ path: p, x, y });
  }
  return s;
}
