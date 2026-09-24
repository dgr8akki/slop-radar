// Builds the Chrome Web Store upload: dist/<name>-<version>.zip containing src/.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('src/manifest.json', root), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

if (manifest.version !== pkg.version) {
  console.error(`Version mismatch: manifest ${manifest.version}, package.json ${pkg.version}.`);
  process.exit(1);
}

const out = new URL(`dist/${pkg.name}-${pkg.version}.zip`, root);
mkdirSync(new URL('dist/', root), { recursive: true });
rmSync(out, { force: true });
execFileSync('zip', ['-qr', out.pathname, '.', '-x', '*.DS_Store'], { cwd: new URL('src/', root) });
console.log(`Packaged ${out.pathname}`);
