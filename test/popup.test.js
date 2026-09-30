import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { JSDOM } from 'jsdom';

import { installDom } from './helpers.js';

const HTML = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');

/** A `chrome` double with the storage the popup reads and the change event it listens to. */
function fakeChrome(store = {}) {
  const listeners = [];
  const opened = [];
  return {
    store,
    opened,
    fire: (changes, area = 'local') => listeners.forEach((l) => l(changes, area)),
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(
            [keys]
              .flat()
              .filter((k) => k in store)
              .map((k) => [k, store[k]]),
          );
        },
      },
      onChanged: { addListener: (l) => listeners.push(l) },
    },
    runtime: { openOptionsPage: () => opened.push(Date.now()) },
  };
}

let restore = () => {};
let seq = 0;
afterEach(() => {
  restore();
  delete globalThis.chrome;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function load(store) {
  const chrome = fakeChrome(store);
  restore = installDom(HTML, 'chrome-extension://test/popup/popup.html');
  globalThis.chrome = chrome;
  await import(`../src/popup/popup.js?case=${seq++}`);
  await settle();
  const $ = (id) => globalThis.document.getElementById(id);
  return { chrome, $ };
}

describe('popup', () => {
  it('asks for a key when none is saved, and opens settings from the button', async () => {
    const { chrome, $ } = await load();
    assert.equal($('connection').textContent, 'Connect a TypeSafe or Vercel AI Gateway key to start.');
    assert.equal($('open-settings').textContent, 'Connect Jev');
    assert.ok($('open-settings').classList.contains('btn-primary'));
    assert.ok($('open-settings').classList.contains('btn'), 'base class survives');
    assert.equal($('connection-row').hasAttribute('data-connected'), false);
    $('open-settings').click();
    assert.equal(chrome.opened.length, 1);
  });

  it('shows the provider and a masked key when connected, in separate spans', async () => {
    const { $ } = await load({ apiKey: 'vck_abcdefghijklmnop1234', provider: 'typesafe' });
    const text = $('connection');
    assert.equal(text.childNodes[0].textContent, 'Connected via TypeSafe');
    assert.equal(text.querySelector('.mono').textContent, 'vck_…1234');
    assert.doesNotMatch(text.textContent, /vck_abcdefghijklmnop1234/, 'never the whole key');
    assert.equal($('open-settings').textContent, 'Change');
    assert.ok($('open-settings').classList.contains('btn-secondary'));
    assert.equal($('open-settings').getAttribute('aria-describedby'), 'connection');
    assert.equal($('connection-row').hasAttribute('data-connected'), true);
  });

  it('re-renders when the key is saved or removed in another tab', async () => {
    const { chrome, $ } = await load();
    Object.assign(chrome.store, { apiKey: 'vck_abcdefghijklmnop1234', provider: 'vercel' });
    chrome.fire({ apiKey: { newValue: 'vck_abcdefghijklmnop1234' } });
    await settle();
    assert.match($('connection').textContent, /Connected via Vercel AI Gateway/);
    assert.equal($('connection-row').hasAttribute('data-connected'), true);

    delete chrome.store.apiKey;
    chrome.fire({ apiKey: { oldValue: 'vck_abcdefghijklmnop1234' } });
    await settle();
    assert.equal($('open-settings').textContent, 'Connect Jev');
    assert.equal($('connection-row').hasAttribute('data-connected'), false);

    chrome.fire({ apiKey: { newValue: 'x' } }, 'sync'); // another area: ignored
    await settle();
    assert.equal($('open-settings').textContent, 'Connect Jev');
  });
});

describe('popup markup', () => {
  const { document } = new JSDOM(HTML).window;

  it('puts everything after the wordmark inside one main landmark', () => {
    const main = document.querySelector('main');
    assert.ok(main, 'no <main>');
    for (const sel of ['.intro', 'ul.legend', '.hint', '#connection-row']) {
      assert.ok(main.querySelector(sel), `${sel} outside <main>`);
    }
    assert.equal(document.querySelectorAll('main').length, 1);
  });

  it('names the connection section with a heading screen readers can reach', () => {
    const section = document.getElementById('connection-row');
    const heading = document.getElementById(section.getAttribute('aria-labelledby'));
    assert.equal(heading?.tagName, 'H2');
    assert.equal(heading.textContent, 'Connection');
    assert.ok(heading.classList.contains('visually-hidden'));
  });
});
