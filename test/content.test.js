import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { JSDOM } from 'jsdom';

const SCRIPT = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');

const LONG =
  'I got rejected from 47 jobs. Then everything changed. Here is the thing nobody tells you about consistency.';

/** A LinkedIn-like feed with the markup hooks the content script relies on. */
const post = (key, text) =>
  `<div role="listitem" componentkey="update-card-${key}"><div><span>Author</span></div>` +
  `<p data-testid="expandable-text-box">${text}</p></div>`;

let dom;
afterEach(() => dom?.window.close());

/**
 * Loads the feed, runs content.js in it, and returns controls for the test.
 *
 * @param {string} body
 * @param {(message: any) => any} respond What the service worker replies.
 */
function loadFeed(body, respond, { runtimeId } = {}) {
  dom = new JSDOM(`<main>${body}</main>`, { runScripts: 'outside-only', url: 'https://www.linkedin.com/feed/' });
  const { window } = dom;
  const messages = [];
  const observed = [];
  const timers = [];
  let callback;

  // Waits of a second or more (worker retry, provider pause) are held for the test to fire.
  const realSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...args) => (ms >= 1000 ? timers.push({ fn, ms }) : realSetTimeout(fn, ms, ...args));

  window.IntersectionObserver = class {
    constructor(cb) {
      callback = cb;
    }
    observe(el) {
      observed.push(el);
    }
  };
  const listeners = [];
  window.chrome = {
    runtime: {
      id: runtimeId,
      sendMessage: async (message) => {
        messages.push(message);
        return respond(message);
      },
      onMessage: { addListener: (listener) => listeners.push(listener) },
    },
  };
  window.eval(SCRIPT);

  return {
    window,
    messages,
    observed,
    timers,
    /** Delivers a message from the service worker and waits for what it started. */
    async receive(message) {
      for (const listener of listeners) listener(message, {}, () => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    card: () => window.document.querySelector('.slop-radar-card'),
    /** Runs every held timer and waits for what it started. */
    async fire() {
      for (const { fn } of timers.splice(0)) fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    /** Simulates posts scrolling into view and waits for their labels. */
    async show(...posts) {
      callback(posts.map((target) => ({ target, isIntersecting: true })));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    post: (key) => window.document.querySelector(`[componentkey="update-card-${key}"]`),
  };
}

const rating = (verdict, extra = {}) => ({
  rating: {
    verdict,
    slop: verdict === 'slop' ? 0.9 : 0.1,
    human: verdict === 'human' ? 0.85 : 0.05,
    signals: [],
    ...extra,
  },
});

describe('content script', () => {
  it('observes every post in the feed', () => {
    const feed = loadFeed(post('a', LONG) + post('b', LONG), () => rating('human'));
    assert.equal(feed.observed.length, 2);
  });

  it('labels a post with its verdict and explains why', async () => {
    const feed = loadFeed(post('a', LONG), () => rating('slop', { signals: ['Generic hook', 'Engagement bait'] }));
    await feed.show(feed.post('a'));

    // Messages come from the page's JS realm; compare them as plain data.
    assert.deepEqual(JSON.parse(JSON.stringify(feed.messages)), [{ type: 'rate', text: LONG }]);
    assert.equal(feed.post('a').dataset.slopRadar, 'slop');
    const badge = feed.post('a').querySelector('.slop-radar-badge');
    assert.equal(badge.textContent, 'AI slop');
    assert.equal(
      badge.getAttribute('aria-label'),
      'Slop Radar. AI slop: 90% slop, 5% human. Signals: Generic hook, Engagement bait.',
    );
    assert.equal(badge.getAttribute('role'), 'note');
    assert.equal(badge.tabIndex, 0);
  });

  it('explains the tag in a popover on focus, grouped by direction, and closes on Escape', async () => {
    const feed = loadFeed(post('a', LONG), () =>
      rating('unclear', { signals: ['Generic hook', 'Concrete first-hand details'] }),
    );
    await feed.show(feed.post('a'));
    const badge = feed.post('a').querySelector('.slop-radar-badge');
    badge.dispatchEvent(new feed.window.FocusEvent('focus'));

    const pop = feed.window.document.getElementById('slop-radar-popover').shadowRoot.querySelector('.pop');
    assert.equal(pop.hidden, false);
    assert.equal(pop.querySelector('.title').textContent, 'Could go either way');
    assert.equal(pop.querySelector('.nums').textContent, '5% human85% neither10% slop');
    const groups = [...pop.querySelectorAll('.group')].map((g) => g.textContent);
    assert.deepEqual(groups, ['Pointing to slopGeneric hook', 'Pointing to humanConcrete first-hand details']);
    assert.equal(pop.querySelector('.foot').textContent, 'Judges writing style, not who wrote it.');

    feed.window.document.dispatchEvent(new feed.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(pop.hidden, true);
  });

  it('says exactly what is sent while a post is being checked', async () => {
    const feed = loadFeed(post('a', LONG), () => new Promise(() => {})); // never answers
    await feed.show(feed.post('a'));
    const badge = feed.post('a').querySelector('.slop-radar-badge');
    assert.equal(badge.textContent, 'Checking');
    badge.dispatchEvent(new feed.window.FocusEvent('focus'));
    const pop = feed.window.document.getElementById('slop-radar-popover').shadowRoot.querySelector('.pop');
    assert.equal(
      pop.querySelector('.foot').textContent,
      "Only the post's text is sent, never the author's name or profile.",
    );
  });

  it('marks posts on a dark LinkedIn card so the tags step deeper', async () => {
    const feed = loadFeed(post('a', LONG), () => rating('human'));
    feed.window.document.body.style.backgroundColor = 'rgb(27, 31, 35)';
    await feed.show(feed.post('a'));
    assert.equal(feed.post('a').dataset.slopRadarTheme, 'dark');
  });

  it('skips posts too short to judge', async () => {
    const feed = loadFeed(post('a', 'Congrats!'), () => rating('human'));
    await feed.show(feed.post('a'));
    assert.equal(feed.messages.length, 0);
    assert.equal(feed.post('a').querySelector('.slop-radar-badge'), null);
  });

  it('rates each post once, and again only when its text grows', async () => {
    const feed = loadFeed(post('a', LONG), () => rating('human'));
    await feed.show(feed.post('a'));
    await feed.show(feed.post('a'));
    assert.equal(feed.messages.length, 1);

    feed.post('a').querySelector('p').textContent = `${LONG} ${LONG}`; // "… more" expanded
    await feed.show(feed.post('a'));
    assert.equal(feed.messages.length, 2);
    assert.equal(feed.post('a').querySelectorAll('.slop-radar-badge').length, 1, 'one badge per post');
  });

  it('shows errors on the label instead of failing silently', async () => {
    const feed = loadFeed(post('a', LONG), () => ({ error: 'Add your AI Gateway API key in settings.' }));
    await feed.show(feed.post('a'));
    const badge = feed.post('a').querySelector('.slop-radar-badge');
    assert.equal(badge.textContent, 'Not rated');
    assert.equal(badge.getAttribute('aria-label'), 'Slop Radar. Not rated. Add your AI Gateway API key in settings.');
  });

  it('asks for a reload after the extension is updated', async () => {
    const feed = loadFeed(post('a', LONG), () => {
      throw new Error('Extension context invalidated.');
    });
    await feed.show(feed.post('a'));
    assert.match(feed.post('a').querySelector('.slop-radar-badge').getAttribute('aria-label'), /Reload the page/);
    assert.equal(feed.timers.length, 0);
  });

  it('tries once more after a moment when the worker did not answer', async () => {
    let calls = 0;
    const feed = loadFeed(
      post('a', LONG),
      () => {
        if ((calls += 1) === 1) throw new Error('The message port closed before a response was received.');
        return rating('human');
      },
      { runtimeId: 'abc' },
    );
    await feed.show(feed.post('a'));
    assert.equal(feed.post('a').dataset.slopRadar, 'pending');
    assert.equal(feed.timers.length, 1);
    assert.ok(feed.timers[0].ms >= 500 && feed.timers[0].ms <= 2000, `retry after ${feed.timers[0].ms} ms`);

    await feed.fire();
    assert.equal(feed.messages.length, 2);
    assert.equal(feed.post('a').dataset.slopRadar, 'human');
  });

  it('does not ask for a reload when the worker fails twice, and lets the post be tried again', async () => {
    const feed = loadFeed(
      post('a', LONG),
      () => {
        throw new Error('The message port closed before a response was received.');
      },
      { runtimeId: 'abc' },
    );
    await feed.show(feed.post('a'));
    await feed.fire();
    const badge = feed.post('a').querySelector('.slop-radar-badge');
    assert.equal(badge.textContent, 'Not rated');
    assert.doesNotMatch(badge.getAttribute('aria-label'), /Reload/);
    assert.equal(feed.timers.length, 0);

    await feed.show(feed.post('a')); // scrolled past and back
    assert.equal(feed.messages.length, 3);
  });

  it('shows one connect card instead of a "Not rated" badge per post when there is no key', async () => {
    let connected = false;
    const feed = loadFeed(post('a', LONG) + post('b', LONG) + post('c', LONG), (message) => {
      if (message.type !== 'rate') return {};
      return connected ? rating('human') : { error: 'Add your API key in settings.', code: 'no-key' };
    });
    await feed.show(feed.post('a'), feed.post('b'));

    assert.equal(feed.window.document.querySelectorAll('.slop-radar-badge').length, 0, 'no badges');
    assert.equal(feed.window.document.querySelectorAll('.slop-radar-post').length, 0, 'no card marks');
    const cards = feed.window.document.querySelectorAll('.slop-radar-card');
    assert.equal(cards.length, 1, 'one card');
    const card = cards[0];
    assert.equal(card.parentElement.firstElementChild, card, 'at the top of the feed');
    assert.match(card.textContent, /Slop Radar isn't connected yet/);
    assert.match(card.textContent, /two minutes, costs under a cent a week/);
    assert.equal(card.getAttribute('aria-live'), null);
    const connect = card.querySelector('button.slop-radar-connect');
    assert.equal(connect.textContent, 'Connect Jev');

    connect.click();
    assert.deepEqual(JSON.parse(JSON.stringify(feed.messages.at(-1))), { type: 'open-options' });

    const before = feed.messages.length;
    await feed.show(feed.post('c'));
    assert.equal(feed.messages.length, before, 'no more rate requests while there is no key');

    connected = true;
    await feed.receive({ type: 'status', connected: true });
    assert.equal(feed.card(), null, 'card gone');
    for (const key of ['a', 'b', 'c']) assert.equal(feed.post(key).dataset.slopRadar, 'human', `post ${key} rated`);
    assert.equal(feed.messages.length, before + 3);
  });

  it('names a rejected key on the card, which can be dismissed for the visit', async () => {
    const feed = loadFeed(post('a', LONG) + post('b', LONG), (message) =>
      message.type === 'rate' ? { error: 'Your API key was rejected. Check it in settings.', code: 'bad-key' } : {},
    );
    await feed.show(feed.post('a'));
    const card = feed.card();
    assert.match(card.textContent, /key was rejected/);
    assert.equal(card.querySelector('button.slop-radar-connect').textContent, 'Check the key');
    assert.equal(feed.post('a').querySelector('.slop-radar-badge'), null);

    card.querySelector('button[aria-label="Dismiss"]').click();
    assert.equal(feed.card(), null);
    await feed.show(feed.post('b'));
    assert.equal(feed.card(), null, 'stays dismissed');
    assert.equal(feed.messages.length, 1, 'still no rate requests');
  });

  it('re-rates posts left as "Not rated" once the key is fixed', async () => {
    let broken = true;
    const feed = loadFeed(post('a', LONG), () => (broken ? { error: 'Rating failed.' } : rating('slop')));
    await feed.show(feed.post('a'));
    assert.equal(feed.post('a').dataset.slopRadar, 'error');

    broken = false;
    await feed.receive({ type: 'status', connected: true });
    assert.equal(feed.post('a').dataset.slopRadar, 'slop');
    assert.equal(feed.messages.length, 2);
  });

  it('waits out a provider pause in the page, then asks again', async () => {
    let calls = 0;
    const feed = loadFeed(post('a', LONG) + post('b', LONG), () =>
      (calls += 1) <= 2 ? { error: 'Jev is busy. Try again in 30s.', retryAfter: 30 } : rating('slop'),
    );
    await feed.show(feed.post('a'), feed.post('b'));
    assert.equal(feed.post('a').dataset.slopRadar, 'pending', 'still checking, not "Not rated"');
    assert.equal(feed.post('b').dataset.slopRadar, 'pending');
    assert.deepEqual(
      feed.timers.map((t) => t.ms),
      [30_000, 30_000],
    );

    await feed.fire();
    assert.equal(feed.messages.length, 4);
    assert.equal(feed.post('a').dataset.slopRadar, 'slop');
    assert.equal(feed.post('b').dataset.slopRadar, 'slop');
  });
});
