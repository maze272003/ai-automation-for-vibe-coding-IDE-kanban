// apps/desktop/scripts/build.mjs — bundles main, preload and orchestrator; copies migrations and the UI.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const out = path.join(root, 'apps', 'desktop', 'dist');
const withUi = !process.argv.includes('--no-ui');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const common = { bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'warning', sourcemap: true };
await build({ ...common, entryPoints: [path.join(root, 'apps/desktop/src/main/index.ts')], outfile: path.join(out, 'main.cjs'), external: ['electron'] });
await build({ ...common, entryPoints: [path.join(root, 'apps/desktop/src/preload/index.ts')], outfile: path.join(out, 'preload.cjs'), external: ['electron'], sourcemap: false });
await build({ ...common, entryPoints: [path.join(root, 'apps/orchestrator/src/main.ts')], outfile: path.join(out, 'orchestrator.cjs'), external: ['better-sqlite3', 'pino'] });

fs.cpSync(path.join(root, 'packages/db/migrations'), path.join(out, 'migrations'), { recursive: true });
fs.cpSync(path.join(root, 'apps/desktop/assets/opencode-runtime'), path.join(out, 'opencode-runtime'), { recursive: true });
if (withUi) {
  const ui = path.join(root, 'apps/ui/dist');
  if (!fs.existsSync(path.join(ui, 'index.html'))) throw new Error('apps/ui/dist is missing — run `npm run build -w @aik/ui` first');
  fs.cpSync(ui, path.join(out, 'ui'), { recursive: true });
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'));
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'ai-kanban', productName: 'AI Kanban', version: pkg.version, main: 'main.cjs' }, null, 2));
console.log(`desktop build written to ${path.relative(root, out)}${withUi ? '' : ' (without UI)'}`);
