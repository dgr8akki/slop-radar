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
function loadFeed(body, respond, { runtimeId, path = '/feed/' } = {}) {
  dom = new JSDOM(`<main>${body}</main>`, {
    runScripts: 'outside-only',
    url: `https://www.linkedin.com${path}`,
    pretendToBeVisual: true, // document.hidden is false, as in a foreground tab
  });
  const { window } = dom;
  const messages = [];
  const observed = [];
  const unobserved = [];
  const timers = [];
  let callback;

  // Waits of a second or more (worker retry, provider pause, reply timeout) are held for the test to fire.
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  let heldId = 1_000_000;
  window.setTimeout = (fn, ms, ...args) => {
    if (ms < 1000) return realSetTimeout(fn, ms, ...args);
    const id = (heldId += 1);
    timers.push({ id, fn, ms });
    return id;
  };
  window.clearTimeout = (id) => {
    const held = timers.findIndex((t) => t.id === id);
    if (held >= 0) timers.splice(held, 1);
    else realClearTimeout(id);
  };

  window.IntersectionObserver = class {
    constructor(cb) {
      callback = cb;
    }
    observe(el) {
      observed.push(el);
    }
    unobserve(el) {
      unobserved.push(el);
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
    unobserved,
    timers,
    /** Waits for the debounced scan after DOM changes. */
    settle: () => new Promise((resolve) => setTimeout(resolve, 350)),
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
    /** Simulates posts scrolling out of view. */
    async leave(...posts) {
      callback(posts.map((target) => ({ target, isIntersecting: false })));
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

describe('popover stylesheet', () => {
  const css = SCRIPT.slice(
    SCRIPT.indexOf('const POPOVER_CSS'),
    SCRIPT.indexOf('`;', SCRIPT.indexOf('const POPOVER_CSS')),
  );

  it('has no text under 12px and grows with its content instead of a fixed width', () => {
    const sizes = [...css.matchAll(/font(?:-size)?: (\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    assert.ok(sizes.length >= 4, 'sizes found');
    assert.ok(
      sizes.every((px) => px >= 12),
      `sizes ${sizes.join(', ')}`,
    );
    assert.match(css, /\.pop \{[^}]*min-width: \$\{POPOVER_WIDTH\}px/);
    assert.doesNotMatch(css, /\.pop \{[^}]*[^-]width: /);
  });

  it('takes its colours from the shared custom properties, not its own hex values', () => {
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
    const content = readFileSync(new URL('../src/content/content.css', import.meta.url), 'utf8');
    for (const name of [...new Set(css.match(/--slop-radar-[\w-]+/g))]) {
      assert.match(content, new RegExp(`${name}:`), `${name} is defined in content.css`);
    }
  });

  it('outlines each meter segment so adjacent shares do not rely on hue alone', () => {
    assert.match(css, /\.meter div \{[^}]*outline: 1px solid rgb\(46 43 37 \/ 40%\)/);
  });
});

describe('content script', () => {
  it('observes every post in the feed', () => {
    const feed = loadFeed(post('a', LONG) + post('b', LONG), () => rating('human'));
    assert.equal(feed.observed.length, 2);
  });

  it('picks up posts added to the feed later, without polling', async () => {
    const feed = loadFeed(post('a', LONG), () => rating('human'));
    assert.equal(feed.observed.length, 1);
    feed.window.document.querySelector('main').insertAdjacentHTML('beforeend', post('b', LONG));
    await feed.settle();
    assert.equal(feed.observed.length, 2);
    assert.equal(feed.observed[1], feed.post('b'));
  });

  it('stops watching a post once it has a verdict, and looks again when it is clicked', async () => {
    const feed = loadFeed(post('a', LONG), () => rating('slop'));
    await feed.show(feed.post('a'));
    assert.deepEqual(feed.unobserved, [feed.post('a')]);
    feed.post('a').querySelector('p').click(); // "…more"
    assert.equal(feed.observed.filter((el) => el === feed.post('a')).length, 2, 'observed again');
    await feed.show(feed.post('a')); // the click did not grow the text
    assert.equal(feed.unobserved.length, 2, 'let go again rather than watched for good');
    assert.equal(feed.messages.filter((m) => m.type === 'rate').length, 1);
  });

  it('keeps a pinned popover when the pointer presses inside it', async () => {
    const feed = loadFeed(post('a', LONG), () => rating('human'));
    await feed.show(feed.post('a'));
    feed.post('a').querySelector('.slop-radar-badge').click();
    const host = feed.window.document.getElementById('slop-radar-popover');
    const press = new feed.window.MouseEvent('mousedown', { cancelable: true, bubbles: true });
    host.dispatchEvent(press);
    assert.equal(press.defaultPrevented, true, 'focus stays on the tag');
  });

  it('does not look for posts away from the feed, and starts again on returning', async () => {
    const feed = loadFeed('', () => rating('human'), { path: '/messaging/' });
    const main = feed.window.document.querySelector('main');
    main.insertAdjacentHTML('beforeend', post('a', LONG));
    await feed.settle();
    assert.equal(feed.observed.length, 0, 'messaging is not a feed');

    feed.window.history.pushState({}, '', '/feed/');
    main.insertAdjacentHTML('beforeend', post('b', LONG));
    await feed.settle();
    assert.deepEqual(feed.observed, [feed.post('a'), feed.post('b')]);

    feed.window.history.pushState({}, '', '/jobs/');
    main.insertAdjacentHTML('beforeend', post('c', LONG));
    await feed.settle();
    assert.equal(feed.observed.length, 2, 'nothing new on the jobs route');
  });

  it('labels a post with its verdict and explains why', async () => {
    const feed = loadFeed(post('a', LONG), () => rating('slop', { signals: ['Generic hook', 'Engagement bait'] }));
    await feed.show(feed.post('a'));

    // Messages come from the page's JS realm; compare them as plain data.
    assert.deepEqual(JSON.parse(JSON.stringify(feed.messages)), [{ type: 'rate', id: 1, text: LONG }]);
    assert.equal(feed.post('a').dataset.slopRadar, 'slop');
    const badge = feed.post('a').querySelector('.slop-radar-badge');
    assert.equal(badge.textContent, 'Reads like AI');
    assert.equal(
      badge.getAttribute('aria-label'),
      'Slop Radar. Reads like AI: 90% slop, 5% human. Signals: Generic hook, Engagement bait.',
    );
    assert.equal(badge.tagName, 'BUTTON', 'a control, since it opens something');
    assert.equal(badge.getAttribute('type'), 'button');
    assert.equal(badge.getAttribute('role'), null);
    assert.equal(badge.getAttribute('aria-expanded'), 'false');
  });

  it("moves the tag left of the header's right-hand control when the two would meet", async () => {
    const plain = loadFeed(post('a', LONG), () => rating('human'));
    await plain.show(plain.post('a'));
    const badge = plain.post('a').querySelector('.slop-radar-badge');
    assert.equal(badge.style.right, '', 'no overlap, no move');
    plain.window.close();

    const feed = loadFeed(post('a', LONG), () => rating('human'));
    const rect = (left, right, top, bottom) => ({
      left,
      right,
      top,
      bottom,
      width: right - left,
      height: bottom - top,
    });
    feed.window.Element.prototype.getBoundingClientRect = function () {
      if (this.classList.contains('slop-radar-badge')) return rect(400, 470, 8, 32);
      if (this.tagName === 'SPAN' && this.textContent === 'Author') return rect(430, 460, 4, 28); // the "…" menu
      if (this.tagName === 'DIV' && this.firstElementChild?.tagName === 'SPAN') return rect(0, 555, 0, 40); // header
      return rect(0, 555, 0, 300); // the post
    };
    await feed.show(feed.post('a'));
    const moved = feed.post('a').querySelector('.slop-radar-badge');
    assert.equal(moved.style.right, '133px', 'post right 555 - control left 430 + 8');
    assert.equal(moved.style.top, '', 'stays in the header row');
  });

  it('opens and closes the popover on click, keeping aria-expanded in step', async () => {
    const feed = loadFeed(post('a', LONG), () => rating('human'));
    await feed.show(feed.post('a'));
    const badge = feed.post('a').querySelector('.slop-radar-badge');
    let bubbled = 0;
    feed.post('a').addEventListener('click', () => (bubbled += 1));

    badge.click();
    const pop = feed.window.document.getElementById('slop-radar-popover').shadowRoot.querySelector('.pop');
    assert.equal(pop.hidden, false);
    assert.equal(badge.getAttribute('aria-expanded'), 'true');
    badge.click();
    assert.equal(pop.hidden, true);
    assert.equal(badge.getAttribute('aria-expanded'), 'false');
    assert.equal(bubbled, 0, "the card's own click handlers are not triggered");

    // A hover opens it; a click then pins it, so moving the pointer away no longer hides it.
    badge.dispatchEvent(new feed.window.MouseEvent('mouseenter'));
    assert.equal(pop.hidden, false);
    badge.click();
    assert.equal(pop.hidden, false, 'clicking a hovered tag keeps the popover, it does not close it');
    badge.dispatchEvent(new feed.window.MouseEvent('mouseleave'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(pop.hidden, false, 'pinned');
    badge.click();
    assert.equal(pop.hidden, true);

    // Focus opens it too; Escape closes and focus stays put.
    badge.dispatchEvent(new feed.window.FocusEvent('focus'));
    assert.equal(badge.getAttribute('aria-expanded'), 'true');
    feed.window.document.dispatchEvent(new feed.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(pop.hidden, true);
    assert.equal(badge.getAttribute('aria-expanded'), 'false');
  });

  it('popover on focus, Escape closes', async () => {
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

  it('30 s from the worker starting, not from queueing', async () => {
    const feed = loadFeed(post('a', LONG) + post('b', LONG), () => ({ queued: true }), { runtimeId: 'abc' });
    await feed.show(feed.post('a'), feed.post('b'));
    assert.equal(feed.post('a').dataset.slopRadar, 'pending');
    const ids = feed.messages.map((m) => m.id);
    assert.deepEqual(ids, [1, 2]);
    assert.deepEqual(
      feed.timers.map((t) => t.ms),
      [120_000, 120_000],
      'only a long watchdog while queued',
    );

    await feed.receive({ type: 'started', id: 1 });
    assert.deepEqual(
      feed.timers.map((t) => t.ms),
      [120_000, 30_000],
      'the 30 s clock starts with the request',
    );
    await feed.receive({ type: 'rated', id: 1, ...rating('human') });
    assert.equal(feed.post('a').dataset.slopRadar, 'human');
    assert.deepEqual(
      feed.timers.map((t) => t.ms),
      [120_000],
      'answered: its timer is gone',
    );

    await feed.receive({ type: 'started', id: 2 });
    await feed.fire(); // 30 s pass with no answer
    const badge = feed.post('b').querySelector('.slop-radar-badge');
    assert.equal(badge.textContent, 'Not rated');
    assert.match(badge.getAttribute('aria-label'), /took too long/);
    await feed.show(feed.post('b')); // scrolled past and back: asks again
    assert.equal(feed.messages.filter((m) => m.type === 'rate').length, 3);
  });

  it('cancel on scroll-away, ask again on return', async () => {
    const feed = loadFeed(post('a', LONG), () => ({ queued: true }), { runtimeId: 'abc' });
    await feed.show(feed.post('a'));
    await feed.leave(feed.post('a'));
    assert.deepEqual(JSON.parse(JSON.stringify(feed.messages.at(-1))), { type: 'cancel', id: 1 });
    assert.equal(feed.post('a').querySelector('.slop-radar-badge'), null, 'no tag on a post nobody is looking at');
    assert.equal(feed.timers.length, 0);

    await feed.show(feed.post('a'));
    assert.deepEqual(JSON.parse(JSON.stringify(feed.messages.at(-1))), { type: 'rate', id: 2, text: LONG });

    // Once the worker has started on it, leaving does not cancel.
    await feed.receive({ type: 'started', id: 2 });
    await feed.leave(feed.post('a'));
    assert.equal(feed.messages.filter((m) => m.type === 'cancel').length, 1);
    await feed.receive({ type: 'rated', id: 2, ...rating('slop') });
    assert.equal(feed.post('a').dataset.slopRadar, 'slop');
  });

  it('still accepts an answer on the request itself', async () => {
    const feed = loadFeed(post('a', LONG), () => rating('human'));
    await feed.show(feed.post('a'));
    assert.equal(feed.post('a').dataset.slopRadar, 'human');
    assert.deepEqual(feed.timers, [], 'nothing left to fire');
  });

  it('falls back to the error glyph for a verdict it does not know', async () => {
    const feed = loadFeed(post('a', LONG), () => rating('sarcastic'));
    await feed.show(feed.post('a'));
    const badge = feed.post('a').querySelector('.slop-radar-badge');
    assert.equal(feed.post('a').dataset.slopRadar, 'error');
    assert.equal(badge.textContent, 'Not rated');
    assert.ok(badge.querySelector('svg.g-error'), 'error glyph');
    assert.doesNotMatch(badge.innerHTML, /undefined/);
    assert.match(badge.getAttribute('aria-label'), /Unexpected reply/);
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

  it('flips the popover above the tag when there is no room below', async () => {
    const feed = loadFeed(post('a', LONG), () => rating('human'));
    await feed.show(feed.post('a'));
    const badge = feed.post('a').querySelector('.slop-radar-badge');
    const rect = (top) => ({ top, bottom: top + 24, left: 430, right: 500, width: 70, height: 24 });
    badge.getBoundingClientRect = () => rect(100);
    badge.dispatchEvent(new feed.window.FocusEvent('focus'));
    const pop = feed.window.document.getElementById('slop-radar-popover').shadowRoot.querySelector('.pop');
    Object.defineProperty(pop, 'offsetHeight', { value: 200 });
    assert.equal(feed.window.innerHeight, 768);

    badge.dispatchEvent(new feed.window.FocusEvent('focus'));
    assert.equal(pop.style.top, '130px', 'below: 6px under the tag');
    assert.equal(pop.style.left, '212px', 'right-aligned to the tag at its minimum width');

    badge.getBoundingClientRect = () => rect(740);
    badge.dispatchEvent(new feed.window.FocusEvent('focus'));
    assert.equal(pop.style.top, '534px', 'above: 740 - 6 - 200');
  });

  it('keeps the popover open while the pointer crosses into it, then hides it', async () => {
    const feed = loadFeed(post('a', LONG), () => rating('human'));
    await feed.show(feed.post('a'));
    const badge = feed.post('a').querySelector('.slop-radar-badge');
    const { MouseEvent } = feed.window;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    badge.dispatchEvent(new MouseEvent('mouseenter'));
    const pop = feed.window.document.getElementById('slop-radar-popover').shadowRoot.querySelector('.pop');
    assert.equal(pop.hidden, false);

    badge.dispatchEvent(new MouseEvent('mouseleave'));
    assert.equal(pop.hidden, false, 'not hidden on the spot');
    await wait(60);
    pop.dispatchEvent(new MouseEvent('mouseenter')); // within the 150 ms grace
    await wait(250);
    assert.equal(pop.hidden, false, 'reading the popover keeps it open');

    pop.dispatchEvent(new MouseEvent('mouseleave'));
    await wait(250);
    assert.equal(pop.hidden, true);
  });

  it('treats a transparent chain of ancestors as light', async () => {
    const feed = loadFeed(post('a', LONG), () => rating('human'));
    await feed.show(feed.post('a'));
    assert.equal(feed.post('a').dataset.slopRadarTheme, undefined);
  });

  it("marks posts on LinkedIn's #1b1f23 dark card", async () => {
    const feed = loadFeed(post('a', LONG), () => rating('human'));
    feed.post('a').style.backgroundColor = '#1b1f23';
    await feed.show(feed.post('a'));
    assert.equal(feed.post('a').dataset.slopRadarTheme, 'dark');
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

  it('error tag, then asks again on re-entry', async () => {
    const feed = loadFeed(post('a', LONG), () => ({ error: 'Add your AI Gateway API key in settings.' }));
    await feed.show(feed.post('a'));
    const badge = feed.post('a').querySelector('.slop-radar-badge');
    assert.equal(badge.textContent, 'Not rated');
    assert.equal(badge.getAttribute('aria-label'), 'Slop Radar. Not rated. Add your AI Gateway API key in settings.');
    badge.dispatchEvent(new feed.window.FocusEvent('focus'));
    const pop = feed.window.document.getElementById('slop-radar-popover').shadowRoot.querySelector('.pop');
    assert.equal(pop.querySelector('.foot').textContent, 'Labels resume automatically when rating works again.');
    await feed.show(feed.post('a'));
    assert.equal(feed.messages.filter((m) => m.type === 'rate').length, 2, 'asked again on re-entry');
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

  it('two dropped ports: no reload advice', async () => {
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
    assert.match(card.textContent, /Connecting takes two minutes and costs under a cent a week\./);
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

  it('forgets skipped posts that left the feed, and keeps at most a screenful of them', async () => {
    const many = Array.from({ length: 60 }, (_, i) => post(`p${i}`, LONG)).join('');
    const feed = loadFeed(many, (message) =>
      message.type === 'rate' ? { error: 'Add your API key in settings.', code: 'no-key' } : {},
    );
    const posts = Array.from({ length: 60 }, (_, i) => feed.post(`p${i}`));
    await feed.show(posts[0]);
    await feed.show(...posts.slice(1));
    posts[59].remove(); // scrolled out of the virtualised list
    await feed.receive({ type: 'status', connected: true });
    const rated = feed.messages.filter((m) => m.type === 'rate').length;
    assert.ok(rated <= 41, `${rated} rate requests after resume`);
    assert.ok(rated >= 40, `${rated} rate requests after resume`);
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
