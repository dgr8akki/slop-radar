/**
 * Manifest assertions every Jev extension shares. Each repo's
 * test/manifest.test.js registers them and adds its own permission checks:
 *
 *   describe('manifest', () => {
 *     describeSharedManifest(new URL('../', import.meta.url));
 *     it('asks for storage only', …);
 *   });
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { it } from 'node:test';

/**
 * storage.local.setAccessLevel is usable from a service worker since Chrome 140.
 * On 116-139 the method exists but throws synchronously for that area, so
 * neither `?.()` nor a typeof check helps: a throw at the top of the worker
 * stops every listener below it from registering. Only a try block counts.
 */
const SET_ACCESS_LEVEL_SINCE = 140;
const STORE_DESCRIPTION_LIMIT = 132;

/**
 * @param {URL} root Repo root (directory URL, with a trailing slash).
 * @returns {{ name: string, run: () => void }[]}
 */
export function sharedManifestChecks(root) {
  const src = new URL('src/', root);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', src), 'utf8'));
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

  return [
    {
      name: 'is Manifest V3 with the package version',
      run() {
        assert.equal(manifest.manifest_version, 3);
        assert.equal(manifest.version, pkg.version, `manifest ${manifest.version} vs package.json ${pkg.version}`);
      },
    },
    {
      name: 'references only files that exist',
      run() {
        const files = [
          manifest.background?.service_worker,
          manifest.action?.default_popup,
          manifest.options_ui?.page,
          manifest.side_panel?.default_path,
          ...(manifest.content_scripts ?? []).flatMap((c) => [...(c.js ?? []), ...(c.css ?? [])]),
          ...Object.values(manifest.icons ?? {}),
          ...Object.values(manifest.action?.default_icon ?? {}),
          ...(manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources),
        ].filter(Boolean);
        for (const file of files) assert.ok(existsSync(new URL(file, src)), `missing ${file}`);
      },
    },
    {
      name: `keeps the store description within ${STORE_DESCRIPTION_LIMIT} characters`,
      run() {
        assert.ok(manifest.description.length <= STORE_DESCRIPTION_LIMIT, `${manifest.description.length} chars`);
      },
    },
    {
      name: 'guards setAccessLevel on Chrome versions that lack it',
      run() {
        const worker = manifest.background?.service_worker;
        if (!worker || Number(manifest.minimum_chrome_version) >= SET_ACCESS_LEVEL_SINCE) return;
        const source = readFileSync(new URL(worker, src), 'utf8');
        const call = /\bsetAccessLevel(\?\.)?\(/;
        // Blank out try blocks (keeping line breaks so line numbers still point into the original file),
        // then any call left is one nothing catches.
        const outsideTry = source.replace(/try\s*\{[\s\S]*?\}\s*(?=catch\b|finally\b)/g, (block) =>
          block.replace(/[^\n]/g, ' '),
        );
        const lines = outsideTry
          .split('\n')
          .map((line, i) => (call.test(line) ? `${worker}:${i + 1}` : null))
          .filter(Boolean);
        assert.equal(
          lines.length,
          0,
          `setAccessLevel is called outside a try block at ${lines.join(', ')}, but minimum_chrome_version is ` +
            `${manifest.minimum_chrome_version}: Chrome < ${SET_ACCESS_LEVEL_SINCE} throws on that call and the ` +
            'worker dies before its listeners register. Wrap it in try { … } catch {}.',
        );
      },
    },
  ];
}

/** Registers the shared checks as `it` blocks inside the caller's `describe`. */
export function describeSharedManifest(root) {
  for (const { name, run } of sharedManifestChecks(root)) it(name, run);
}
