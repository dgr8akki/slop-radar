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
  await import(`../src/options/options.js?case=${seq++}`);
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

const status = ($, id) => ({ text: $(id).textContent, tone: $(id).dataset.tone });

describe('settings page: checking a key', () => {
  it('saves a key the provider answers properly', async () => {
    const page = await load({ replies: [OK()] });
    await submit(page, 'vck_new_key_123456');
    assert.equal(page.chrome.store.apiKey, 'vck_new_key_123456');
    assert.equal(page.chrome.store.provider, 'vercel');
    assert.equal(page.$('key-form').hidden, true);
    assert.deepEqual(status(page.$, 'connected-status'), {
      text: 'Key works. Reload LinkedIn to see labels.',
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
      text: 'Provider is busy; the key format was accepted. Reload LinkedIn to see labels.',
      tone: 'ok',
    });

    // The Test button on the connected card gets the same qualified wording.
    globalThis.fetch = async () => json(429, {});
    click(page, 'test');
    await settle();
    await settle();
    assert.deepEqual(status(page.$, 'connected-status'), {
      text: 'Provider is busy; the key format was accepted.',
      tone: 'ok',
    });
  });

  it('logs an unexpected error and keeps the key out of storage', async () => {
    // Not a Response at all: the client trips over it, which is a bug, not a provider answer.
    const page = await load({ replies: [{}] });
    await submit(page, 'vck_new_key_123456');
    assert.equal(page.chrome.store.apiKey, undefined);
    assert.equal(page.logged.length, 1, 'one console.error');
    assert.ok(page.logged[0][0] instanceof TypeError, 'the original error is logged');
    assert.deepEqual(status(page.$, 'key-status'), {
      text: 'Something went wrong while checking the key. Try again.',
      tone: 'error',
    });
  });
});

describe('settings page: where focus lands', () => {
  it('moves to the connected card title after a successful connect', async () => {
    const page = await load({ replies: [OK()] });
    await submit(page, 'vck_new_key_123456');
    const title = page.$('connected-title');
    assert.equal(title.getAttribute('tabindex'), '-1', 'title can take programmatic focus');
    assert.equal(page.document.activeElement, title);
  });

  it('returns to the connected card title on Cancel, and stays on the key field after Remove', async () => {
    const page = await load({ store: { apiKey: 'vck_old_key_123456', provider: 'vercel' } });
    click(page, 'replace');
    assert.equal(page.document.activeElement, page.$('api-key'));
    click(page, 'cancel');
    assert.equal(page.$('key-form').hidden, true);
    assert.equal(page.document.activeElement, page.$('connected-title'));

    click(page, 'remove');
    await settle();
    await settle();
    assert.equal(page.chrome.store.apiKey, undefined);
    assert.equal(page.$('key-form').hidden, false);
    assert.equal(page.document.activeElement, page.$('api-key'));
  });
});
