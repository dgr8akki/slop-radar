import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { describeSharedManifest } from './manifest-shared.js';

const root = new URL('../', import.meta.url);
const src = new URL('src/', root);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', src), 'utf8'));

describe('manifest', () => {
  describeSharedManifest(root);

  it('runs only on LinkedIn and talks only to the two Jev providers', () => {
    assert.deepEqual(manifest.permissions, ['storage']);
    assert.deepEqual(manifest.host_permissions, ['https://ai-gateway.vercel.sh/*', 'https://api.typesafe.ai/*']);
    assert.deepEqual(
      manifest.content_scripts.flatMap((c) => c.matches),
      ['https://www.linkedin.com/*'],
    );
  });

  it('requires Chrome 140, where the worker can keep storage.local from the content script', () => {
    // storage.local.setAccessLevel throws on older builds; the floor keeps the isolation real, and the
    // try block keeps the worker alive if the floor is ever lowered.
    assert.ok(Number(manifest.minimum_chrome_version) >= 140, manifest.minimum_chrome_version);
    const background = readFileSync(new URL(manifest.background.service_worker, src), 'utf8');
    assert.match(background, /try\s*\{[^}]*setAccessLevel\(/);
  });
});
