import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { JSDOM } from 'jsdom';

const HTML = readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8');

/** A `chrome` double with the storage the settings page uses. `store` is the backing object. */
function fakeChrome(store = {}) {
  return {
    store,
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(names.filter((name) => name in store).map((name) => [name, store[name]]));
        },
        async set(values) {
          Object.assign(store, values);
        },
        async remove(key) {
          delete store[key];
        },
      },
    },
  };
}

/** Exposes the settings page as the globals options.js expects, plus `chrome`. Returns a restore function. */
function installPage(chrome) {
  const { window } = new JSDOM(HTML, { url: 'chrome-extension://test/options/options.html', pretendToBeVisual: true });
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Event', 'chrome'];
  // defineProperty, not assignment: Node exposes `navigator` through a getter-only accessor.
  const define = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const previous = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const name of names) define(name, name === 'window' ? window : name === 'chrome' ? chrome : window[name]);
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    window.close();
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let restore = () => {};
let seq = 0;
const realConsoleError = console.error;
afterEach(() => {
  restore();
  delete globalThis.fetch;
  console.error = realConsoleError;
});

/**
 * Loads options.js fresh against the real options.html. Each entry in `replies` answers one key check:
 * a Response, or an Error for a fetch that rejects.
 */
async function load({ store = {}, replies = [] } = {}) {
  const chrome = fakeChrome(store);
  restore = installPage(chrome);
  const logged = [];
  console.error = (...args) => logged.push(args);
  globalThis.fetch = async () => {
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  };
  await import(`../src/options/options.js?case=${seq}`);
  await import(`../src/options/reveal.js?case=${seq++}`);
  await settle();
  const $ = (id) => globalThis.document.getElementById(id);
  return { chrome, logged, $, document: globalThis.document, window: globalThis.window };
}

const json = (status, body) => new Response(JSON.stringify(body), { status });
const OK = () => json(200, { answers: { ok: { type: 'choice', choice: 'yes', probabilities: { yes: 1 } } } });

async function submit({ $, window }, key) {
  $('api-key').value = key;
  $('key-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();
  await settle();
  await settle();
}

const click = ({ $ }, id) => $(id).click();

// The mark templates carry whitespace text nodes; compare the words only.
const status = ($, id) => ({ text: $(id).textContent.replace(/\s+/g, ' ').trim(), tone: $(id).dataset.tone });

describe('settings page: checking a key', () => {
  it('saves a key the provider answers properly', async () => {
    const page = await load({ replies: [OK()] });
    await submit(page, 'vck_new_key_123456');
    assert.equal(page.chrome.store.apiKey, 'vck_new_key_123456');
    assert.equal(page.chrome.store.provider, 'vercel');
    assert.equal(page.$('key-form').hidden, true);
    assert.deepEqual(status(page.$, 'connected-status'), {
      text: 'Key works. Open your LinkedIn feed and scroll; labels appear as posts come into view.',
      tone: 'ok',
    });
  });

  it('refuses a 200 that is not JSON, keeping the previous key', async () => {
    const page = await load({
      store: { apiKey: 'vck_old_key_123456', provider: 'vercel' },
      replies: [new Response('<!doctype html><title>Sign in</title>', { status: 200 })],
    });
    click(page, 'replace');
    await submit(page, 'vck_new_key_123456');
    assert.equal(page.chrome.store.apiKey, 'vck_old_key_123456');
    assert.equal(page.$('key-form').hidden, false);
    assert.deepEqual(status(page.$, 'key-status'), {
      text: 'Unexpected reply from ai-gateway.vercel.sh.',
      tone: 'error',
    });
  });

  it('refuses a 200 with an empty object', async () => {
    const page = await load({ replies: [json(200, {})] });
    await submit(page, 'vck_new_key_123456');
    assert.equal(page.chrome.store.apiKey, undefined);
    assert.deepEqual(status(page.$, 'key-status'), {
      text: 'Unexpected reply from ai-gateway.vercel.sh.',
      tone: 'error',
    });
  });

  it('explains a network failure instead of showing "Failed to fetch"', async () => {
    const page = await load({ replies: [new TypeError('Failed to fetch')] });
    await submit(page, 'vck_new_key_123456');
    assert.equal(page.chrome.store.apiKey, undefined);
    assert.deepEqual(status(page.$, 'key-status'), {
      text: "Can't reach ai-gateway.vercel.sh. Check your connection and try again.",
      tone: 'error',
    });
  });

  it('saves the key on a 429 but says the provider was busy, not that the key works', async () => {
    const page = await load({ replies: [json(429, {})] });
    await submit(page, 'vck_new_key_123456');
    assert.equal(page.chrome.store.apiKey, 'vck_new_key_123456');
    assert.deepEqual(status(page.$, 'connected-status'), {
      text: 'Key accepted; the provider is busy right now.',
      tone: 'neutral',
    });

    // The Test button on the connected card gets the same qualified wording.
    globalThis.fetch = async () => json(429, {});
    click(page, 'test');
    await settle();
    await settle();
    assert.deepEqual(status(page.$, 'connected-status'), {
      text: 'Key accepted; the provider is busy right now.',
      tone: 'neutral',
    });
  });

  it('marks the field invalid for a rejected key and clears that on typing', async () => {
    const page = await load({ replies: [json(401, {})] });
    await submit(page, 'vck_new_key_123456');
    assert.equal(page.chrome.store.apiKey, undefined);
    assert.equal(page.$('api-key').getAttribute('aria-invalid'), 'true');
    assert.match(page.$('key-status').textContent, /key was rejected/);
    assert.equal(page.document.activeElement, page.$('api-key'), 'focus goes back to what needs fixing');
    page.$('api-key').dispatchEvent(new page.window.Event('input'));
    assert.equal(page.$('api-key').getAttribute('aria-invalid'), 'false');
    assert.equal(page.$('key-status').textContent, '');
  });

  it("clones this page's marks in front of each status and into the busy button", async () => {
    let release;
    const page = await load();
    globalThis.fetch = () => new Promise((resolve) => (release = () => resolve(OK())));
    page.$('api-key').value = 'vck_new_key_123456';
    page.$('key-form').dispatchEvent(new page.window.Event('submit', { cancelable: true }));
    await settle();
    const button = page.$('key-form').querySelector('button[type="submit"]');
    assert.equal(page.$('api-key').readOnly, true);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.ok(button.querySelector('svg .spin'), 'spinner in the button');
    assert.ok(page.$('key-status').querySelector('svg .spin'), 'spinner in the status');
    release();
    await settle();
    await settle();
    assert.equal(page.$('api-key').readOnly, false);
    assert.ok(page.$('connected-status').querySelector('svg'), 'ok mark in the status');
    assert.match(page.$('steps').innerHTML, /opens in a new tab/);
  });

  it('logs an unexpected error and keeps the key out of storage', async () => {
    // Not a Response at all: the client trips over it, which is a bug, not a provider answer.
    const page = await load({ replies: [{}] });
    await submit(page, 'vck_new_key_123456');
    assert.equal(page.chrome.store.apiKey, undefined);
    assert.equal(page.logged.length, 1, 'one console.error');
    assert.equal(page.logged[0][0], 'Slop Radar: key check failed');
    assert.ok(page.logged[0][1] instanceof TypeError, 'the original error is logged');
    assert.deepEqual(status(page.$, 'key-status'), {
      text: 'Something went wrong while checking the key. Try again.',
      tone: 'error',
    });
  });
});

describe('settings page: where focus lands', () => {
  it('moves to the Test button after a successful connect', async () => {
    const page = await load({ replies: [OK()] });
    await submit(page, 'vck_new_key_123456');
    assert.equal(page.document.activeElement, page.$('test'));
  });

  it('returns to Replace on Cancel, and stays on the key field after Remove', async () => {
    const page = await load({ store: { apiKey: 'vck_old_key_123456', provider: 'vercel' } });
    click(page, 'replace');
    assert.equal(page.document.activeElement, page.$('api-key'));
    click(page, 'cancel');
    assert.equal(page.$('key-form').hidden, true);
    assert.equal(page.document.activeElement, page.$('replace'));

    click(page, 'remove');
    await settle();
    await settle();
    assert.equal(page.chrome.store.apiKey, undefined);
    assert.equal(page.$('key-form').hidden, false);
    assert.equal(page.document.activeElement, page.$('api-key'));
  });
});

describe('settings page: connected card', () => {
  it('leaves the provider choice in place when the key is removed', async () => {
    const page = await load({ store: { apiKey: 'vck_old_key_123456', provider: 'typesafe' } });
    click(page, 'remove');
    await settle();
    await settle();
    assert.deepEqual(page.chrome.store, { provider: 'typesafe' });
    assert.equal(page.$('key-form').hidden, false);
    assert.equal(page.$('host').textContent, 'api.typesafe.ai', 'the form opens on the same provider');
  });

  it('shows the budget message from Test when the provider answers 402', async () => {
    const page = await load({ store: { apiKey: 'vck_old_key_123456', provider: 'vercel' }, replies: [json(402, {})] });
    click(page, 'test');
    await settle();
    await settle();
    assert.deepEqual(status(page.$, 'connected-status'), {
      text: 'Your AI Gateway budget is used up. Raise it in the Vercel dashboard.',
      tone: 'error',
    });
    assert.equal(page.chrome.store.apiKey, 'vck_old_key_123456', 'the key stays');
  });
});

describe('settings page: showing the key', () => {
  it('flips the field between password and text with a pressed Show/Hide button', async () => {
    const page = await load();
    const input = page.$('api-key');
    const reveal = page.$('reveal');
    assert.equal(input.type, 'password');
    assert.equal(reveal.getAttribute('aria-pressed'), 'false');
    assert.equal(reveal.getAttribute('aria-controls'), 'api-key');
    const label = reveal.textContent.trim();
    reveal.click();
    assert.equal(input.type, 'text');
    assert.equal(reveal.getAttribute('aria-pressed'), 'true');
    assert.equal(reveal.textContent.trim(), label, 'the label does not change; the pressed state does');
    assert.equal(page.document.activeElement, input, 'back to typing');
    reveal.click();
    assert.equal(input.type, 'password');
    assert.equal(reveal.getAttribute('aria-pressed'), 'false');
  });

  it('hides the key again when the edit is cancelled', async () => {
    const page = await load({ store: { apiKey: 'vck_old_key_123456', provider: 'vercel' } });
    click(page, 'replace');
    page.$('reveal').click();
    assert.equal(page.$('api-key').type, 'text');
    click(page, 'cancel');
    assert.equal(page.$('api-key').type, 'password');
    assert.equal(page.$('reveal').getAttribute('aria-pressed'), 'false');
  });

  it('hides the key again once the form is submitted', async () => {
    const page = await load({ replies: [OK()] });
    page.$('reveal').click();
    await submit(page, 'vck_new_key_123456');
    assert.equal(page.$('api-key').type, 'password');
    assert.equal(page.$('reveal').getAttribute('aria-pressed'), 'false');
  });
});
