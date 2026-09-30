import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import { describeSharedManifest } from './manifest-shared.js';

const root = new URL('../', import.meta.url);
const src = new URL('src/', root);
const raw = JSON.parse(readFileSync(new URL('manifest.json', src), 'utf8'));

const LOCALES = ['en', 'en_GB'];
const messages = Object.fromEntries(
  LOCALES.map((locale) => [locale, JSON.parse(readFileSync(new URL(`_locales/${locale}/messages.json`, src), 'utf8'))]),
);
/** The manifest as Chrome shows it in the default locale. */
const localised = (value) =>
  typeof value === 'string' ? value.replace(/__MSG_(\w+)__/g, (_, key) => messages.en[key].message) : value;
const manifest = { ...raw, name: localised(raw.name), description: localised(raw.description) };

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

  it('takes its name and summary from _locales, with every English variant complete', () => {
    assert.equal(raw.default_locale, 'en');
    assert.equal(raw.name, '__MSG_name__');
    assert.equal(raw.description, '__MSG_description__');
    const keys = Object.keys(messages.en).sort();
    for (const locale of LOCALES) {
      assert.deepEqual(Object.keys(messages[locale]).sort(), keys, `${locale} keys`);
      for (const key of keys) assert.ok(messages[locale][key].message.trim(), `${locale}.${key} is empty`);
      assert.ok(messages[locale].description.message.length <= 132, `${locale} summary too long`);
    }
    // Only English variants for now: the rating questions are English, so other languages rate less reliably.
    const present = readdirSync(new URL('_locales/', src)).filter((d) => !d.startsWith('.'));
    assert.deepEqual(present.sort(), LOCALES.sort());
    for (const locale of present) assert.match(locale, /^en(_[A-Z]{2})?$/);
  });

  it('keeps LinkedIn out of the title and says "AI" once each in title and summary', () => {
    assert.doesNotMatch(manifest.name, /linkedin/i);
    assert.ok(manifest.name.length <= 45, `${manifest.name.length} chars`);
    assert.equal((manifest.name.match(/\bAI\b/g) ?? []).length, 1);
    assert.equal((manifest.description.match(/\bAI\b/g) ?? []).length, 1);
    assert.equal(manifest.short_name, 'Slop Radar');
    assert.equal(manifest.action.default_title, 'Slop Radar');
  });

  it('requires Chrome 140, where the worker can keep storage.local from the content script', () => {
    // storage.local.setAccessLevel throws on older builds; the floor keeps the isolation real, and the
    // try block keeps the worker alive if the floor is ever lowered.
    assert.ok(Number(manifest.minimum_chrome_version) >= 140, manifest.minimum_chrome_version);
    const background = readFileSync(new URL(manifest.background.service_worker, src), 'utf8');
    assert.match(background, /try\s*\{[^}]*setAccessLevel\(/);
  });
});
