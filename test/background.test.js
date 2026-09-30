import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { SIGNALS } from '../src/lib/rating.js';
import { yesNo } from './helpers.js';

/** A `chrome` double for the service worker: storage, runtime listeners and tabs. */
function fakeChrome({ store = {}, tabs = [], brokenCache = false } = {}) {
  const listeners = { onMessage: [], onChanged: [], onInstalled: [] };
  const sent = [];
  const opened = [];
  const local = {
    setAccessLevel() {},
    async get(key) {
      if (brokenCache && String(key).startsWith('ratings:')) throw new TypeError('storage is on fire');
      if (key === null) return { ...store };
      return Object.fromEntries(
        [key]
          .flat()
          .filter((name) => name in store)
          .map((name) => [name, store[name]]),
      );
    },
    async set(items) {
      Object.assign(store, items);
    },
    async remove(keys) {
      for (const key of [keys].flat()) delete store[key];
    },
  };
  const sessionData = {};
  const session = {
    async get(key) {
      return key in sessionData ? { [key]: sessionData[key] } : {};
    },
    async set(items) {
      Object.assign(sessionData, items);
    },
  };
  return {
    store,
    sessionData,
    listeners,
    sent,
    opened,
    storage: { local, session, onChanged: { addListener: (l) => listeners.onChanged.push(l) } },
    runtime: {
      onInstalled: { addListener: (l) => listeners.onInstalled.push(l) },
      onMessage: { addListener: (l) => listeners.onMessage.push(l) },
      openOptionsPage: () => opened.push(Date.now()),
    },
    tabs: {
      async query() {
        return tabs;
      },
      async sendMessage(id, message) {
        sent.push({ id, message });
        if (id === 2) throw new Error('Could not establish connection. Receiving end does not exist.');
      },
    },
  };
}

const answers = () => ({
  slop: { type: 'score', probabilities: { 0: 0.02, 1: 0.03, 2: 0.05, 3: 0.3, 4: 0.6 } },
  ...Object.fromEntries(Object.keys(SIGNALS).map((key) => [key, yesNo(key === 'hook' ? 0.9 : 0.1)])),
});
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });

let seq = 0;
const logged = [];
const realError = console.error;
afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.fetch;
  console.error = realError;
  logged.length = 0;
});

async function load(options) {
  const chrome = fakeChrome(options);
  globalThis.chrome = chrome;
  console.error = (...args) => logged.push(args);
  await import(`../src/background.js?case=${seq++}`);
  return chrome;
}

/** Sends a message the way Chrome would and resolves with { handled, reply }. */
function send(chrome, message, sender = { tab: { id: 1 } }) {
  return new Promise((resolve) => {
    let replied = false;
    const handled = chrome.listeners.onMessage[0](message, sender, (reply) => {
      replied = true;
      resolve({ handled: true, reply });
    });
    if (handled !== true && !replied) resolve({ handled, reply: undefined });
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Rates from a tab: expects the queued ack, then waits for the answer sent back over the tab. */
async function ask(chrome, message) {
  const ack = await send(chrome, { id: 7, ...message });
  assert.deepEqual(ack, { handled: true, reply: { queued: true } });
  for (let i = 0; i < 50; i++) {
    const rated = chrome.sent.find((s) => s.id === 1 && s.message.type === 'rated' && s.message.id === 7);
    if (rated) {
      const { type, id, ...reply } = rated.message;
      void type;
      void id;
      return { handled: true, reply };
    }
    await settle();
  }
  assert.fail('no rated message reached the tab');
}

const TEXT = 'Rejected from 47 jobs. Then everything changed. Here is the thing nobody tells you about consistency.';

describe('service worker', () => {
  it('registers its listeners even though setAccessLevel may throw', async () => {
    const chrome = fakeChrome();
    chrome.storage.local.setAccessLevel = () => {
      throw new TypeError('Access level is not supported for this storage area.');
    };
    globalThis.chrome = chrome;
    await import(`../src/background.js?case=${seq++}`);
    assert.equal(chrome.listeners.onMessage.length, 1);
    assert.equal(chrome.listeners.onChanged.length, 1);
    assert.equal(chrome.listeners.onInstalled.length, 1);
  });

  it('opens settings on first install only', async () => {
    const chrome = await load();
    chrome.listeners.onInstalled[0]({ reason: 'update' });
    assert.equal(chrome.opened.length, 0);
    chrome.listeners.onInstalled[0]({ reason: 'install' });
    assert.equal(chrome.opened.length, 1);
  });

  it('ignores messages that are not a rating request with text', async () => {
    const chrome = await load();
    assert.deepEqual(await send(chrome, { type: 'hello' }), { handled: false, reply: undefined });
    assert.deepEqual(await send(chrome, { type: 'rate', text: 42 }), { handled: false, reply: undefined });
    assert.deepEqual(await send(chrome, null), { handled: false, reply: undefined });
  });

  it('acknowledges a post from the feed at once, then reports its turn and its verdict over the tab', async () => {
    const chrome = await load({ store: { apiKey: 'vck_test_key_1234567890', provider: 'vercel' } });
    globalThis.fetch = async () => json(200, { answers: answers() });
    const { reply } = await ask(chrome, { type: 'rate', text: TEXT });
    assert.equal(reply.rating.verdict, 'slop');
    assert.deepEqual(reply.rating.signals, [SIGNALS.hook]);
    assert.deepEqual(
      chrome.sent.map((s) => `${s.id}:${s.message.type}:${s.message.id}`),
      ['1:started:7', '1:rated:7'],
    );
  });

  it('drops a queued post the page cancels before its turn', async () => {
    const chrome = await load({ store: { apiKey: 'vck_test_key_1234567890', provider: 'vercel' } });
    let release;
    globalThis.fetch = () => new Promise((resolve) => (release = () => resolve(json(200, { answers: answers() }))));
    await send(chrome, { type: 'rate', id: 1, text: `${TEXT} one` });
    await send(chrome, { type: 'rate', id: 2, text: `${TEXT} two` });
    await send(chrome, { type: 'rate', id: 3, text: `${TEXT} three` });
    await settle();
    assert.deepEqual(await send(chrome, { type: 'cancel', id: 2 }), { handled: false, reply: undefined });
    release();
    for (let i = 0; i < 50 && chrome.sent.filter((s) => s.message.type === 'rated').length < 2; i++) {
      await settle();
      release?.();
    }
    assert.deepEqual(
      chrome.sent.map((s) => `${s.message.type}:${s.message.id}`),
      ['started:1', 'rated:1', 'started:3', 'rated:3'],
    );
  });

  it('answers an extension page on the request itself', async () => {
    const chrome = await load({ store: { apiKey: 'vck_test_key_1234567890', provider: 'vercel' } });
    globalThis.fetch = async () => json(200, { answers: answers() });
    const { reply } = await send(chrome, { type: 'rate', text: TEXT }, {});
    assert.equal(reply.rating.verdict, 'slop');
    assert.equal(chrome.sent.length, 0);
  });

  it('says whether a 401 means no key or a rejected one', async () => {
    const none = await load();
    assert.deepEqual(await ask(none, { type: 'rate', text: TEXT }), {
      handled: true,
      reply: { error: 'Add your API key in settings.', code: 'no-key' },
    });

    const bad = await load({ store: { apiKey: 'vck_test_key_1234567890' } });
    globalThis.fetch = async () => json(401, {});
    assert.deepEqual(await ask(bad, { type: 'rate', text: TEXT }), {
      handled: true,
      reply: { error: 'Your API key was rejected. Check it in settings.', code: 'bad-key' },
    });
    assert.equal(logged.length, 0, 'a key problem is a state the page shows, not a logged error');
  });

  it('hands a long rate limit back with retryAfter, without logging it', async () => {
    const chrome = await load({ store: { apiKey: 'vck_test_key_1234567890' } });
    globalThis.fetch = async () => json(429, {}, { 'retry-after': '120' });
    const { reply } = await ask(chrome, { type: 'rate', text: TEXT });
    assert.equal(reply.retryAfter, 120);
    assert.match(reply.error, /busy/);
    assert.equal(logged.length, 0);
    assert.ok(chrome.sessionData['jev:pausedUntil'] > Date.now(), 'the pause is kept in session storage');
  });

  it("replies with Jev's own words for a provider problem, and a plain line for anything else", async () => {
    const chrome = await load({ store: { apiKey: 'vck_test_key_1234567890' } });
    globalThis.fetch = async () => new Response('{"answers": {', { status: 200 });
    const garbled = await ask(chrome, { type: 'rate', text: TEXT });
    assert.deepEqual(garbled.reply, { error: 'Unexpected reply from ai-gateway.vercel.sh.' });
    assert.equal(logged.length, 1, 'logged once');

    const broken = await load({ store: { apiKey: 'vck_test_key_1234567890' }, brokenCache: true });
    const other = await ask(broken, { type: 'rate', text: TEXT });
    assert.deepEqual(other.reply, { error: "Couldn't rate this one. It'll retry when it scrolls back into view." });
    assert.ok(logged[1][0] instanceof TypeError);
  });

  it('opens settings when the connect card asks', async () => {
    const chrome = await load();
    assert.deepEqual(await send(chrome, { type: 'open-options' }), { handled: true, reply: {} });
    assert.equal(chrome.opened.length, 1);
  });

  it('tells every tab when the key changes, shrugging off tabs without the script', async () => {
    const chrome = await load({ store: { apiKey: 'vck_new_key_1234567890' }, tabs: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    await chrome.listeners.onChanged[0]({ apiKey: { newValue: 'vck_new_key_1234567890' } }, 'local');
    assert.deepEqual(
      chrome.sent.map((s) => s.id),
      [1, 2, 3],
    );
    assert.deepEqual(chrome.sent[0].message, { type: 'status', connected: true });

    chrome.sent.length = 0;
    await chrome.listeners.onChanged[0]({ theme: { newValue: 'x' } }, 'local');
    await chrome.listeners.onChanged[0]({ apiKey: { newValue: 'y' } }, 'sync');
    assert.equal(chrome.sent.length, 0, 'other keys and areas are not broadcast');

    delete chrome.store.apiKey;
    await chrome.listeners.onChanged[0]({ apiKey: { oldValue: 'vck_new_key_1234567890' } }, 'local');
    assert.deepEqual(chrome.sent[0].message, { type: 'status', connected: false });
  });
});
