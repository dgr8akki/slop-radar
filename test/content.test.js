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
function loadFeed(body, respond) {
  dom = new JSDOM(`<main>${body}</main>`, { runScripts: 'outside-only', url: 'https://www.linkedin.com/feed/' });
  const { window } = dom;
  const messages = [];
  const observed = [];
  let callback;

  window.IntersectionObserver = class {
    constructor(cb) {
      callback = cb;
    }
    observe(el) {
      observed.push(el);
    }
  };
  window.chrome = {
    runtime: {
      sendMessage: async (message) => {
        messages.push(message);
        return respond(message);
      },
    },
  };
  window.eval(SCRIPT);

  return {
    window,
    messages,
    observed,
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
    assert.equal(badge.title, 'AI slop: 90% slop, 5% human. Signals: Generic hook, Engagement bait.');
    assert.equal(badge.getAttribute('role'), 'note');
    assert.equal(badge.tabIndex, 0);
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
    assert.equal(badge.title, 'Add your AI Gateway API key in settings.');
  });

  it('asks for a reload after the extension is updated', async () => {
    const feed = loadFeed(post('a', LONG), () => {
      throw new Error('Extension context invalidated.');
    });
    await feed.show(feed.post('a'));
    assert.match(feed.post('a').querySelector('.slop-radar-badge').title, /Reload the page/);
  });
});
