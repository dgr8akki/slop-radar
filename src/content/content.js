/**
 * LinkedIn content script: finds feed posts as they scroll into view, asks the
 * service worker to rate each one, and tags the post with the verdict. Hovering
 * or focusing a tag opens a popover explaining it.
 *
 * Content scripts can't be ES modules, so this file is self-contained.
 *
 * LinkedIn's 2026 markup obfuscates class names. Only two stable hooks are used:
 * a post is `[componentkey^="update-card"]`, its body `[data-testid="expandable-text-box"]`.
 */
(() => {
  // TODO: these break every few months; last checked Sep 2026.
  const POST = '[componentkey^="update-card"]';
  const BODY = '[data-testid="expandable-text-box"]';
  const MIN_CHARS = 80; // too short to judge (reposts, one-liners)
  const REGROW = 1.3; // re-rate when "… more" reveals 30% more text
  const SCAN_DEBOUNCE_MS = 250; // one scan per burst of DOM changes; LinkedIn re-renders constantly
  // Routes that show posts. Everything else on linkedin.com (messaging, jobs, profiles) has none to rate.
  const FEED_ROUTE =
    /^\/(?:$|feed\b|posts\/|in\/[^/]+\/recent-activity|company\/[^/]+\/posts|search\/results\/content)/;
  const HIDE_GRACE_MS = 150; // lets the pointer travel from the tag into the popover
  const RETRY_MS = 1000; // a worker woken by the message sometimes drops that first reply
  const MAX_PAUSE_S = 60; // longest the page waits on a provider pause before asking again
  const REPLY_TIMEOUT_MS = 30_000; // from the worker starting the request; it gives up on the provider at 20 s
  const QUEUE_TIMEOUT_MS = 120_000; // from queueing; only a worker that died mid-queue takes this long
  const POPOVER_WIDTH = 288; // minimum; the card grows for longer signal text
  const HUMAN_SIGNALS = ['Concrete first-hand details']; // SIGNALS.specific in lib/rating.js

  // The tag on a named person's post says "Reads like AI"; the popover title keeps "slop" for the pattern.
  const LABELS = { slop: 'Reads like AI', human: 'Human', unclear: 'Unclear', pending: 'Checking', error: 'Not rated' };
  const TITLES = {
    slop: 'Reads like AI slop',
    human: 'Reads human',
    unclear: 'Could go either way',
    pending: 'Checking',
    error: 'Not rated',
  };

  // One glyph per state (12×12 viewBox); the shape is the cue, the colour just helps.
  const GLYPHS = {
    human: '<circle cx="6" cy="6" r="5" fill="currentColor"/>',
    unclear:
      '<circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
      '<path d="M6 1.4 A4.6 4.6 0 0 1 6 10.6 Z" fill="currentColor"/>',
    slop: '<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="0.1 3.35"/>',
    pending:
      '<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.6"/>' +
      '<g class="slop-radar-spin"><path d="M6 1.6 A4.4 4.4 0 0 1 10.4 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></g>',
    error:
      '<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="1.6"/>' +
      '<path d="M3 9 L9 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  };
  const glyph = (state, size) =>
    `<svg class="g-${state}" width="${size}" height="${size}" viewBox="0 0 12 12" aria-hidden="true">${GLYPHS[state]}</svg>`;

  const observed = new WeakSet();
  const visibility = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) check(entry.target);
        else left(entry.target);
      }
    },
    { threshold: 0.4 },
  );

  // The feed is infinite and re-rendered by React, so rescan the document rather than trust mutation
  // paths; the mutation observer only says when. Nothing runs in a hidden tab or off the feed routes.
  let scanTimer;
  function scan() {
    scanTimer = undefined;
    if (document.hidden || !FEED_ROUTE.test(location.pathname)) return;
    for (const post of document.querySelectorAll(POST)) {
      if (observed.has(post)) continue;
      observed.add(post);
      visibility.observe(post);
    }
  }
  function scanSoon() {
    scanTimer ??= setTimeout(scan, SCAN_DEBOUNCE_MS);
  }
  scan();
  new MutationObserver(scanSoon).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', scanSoon);

  async function check(post, retried = false) {
    if (paused) return remember(post); // rated when a key arrives; see resume()
    const text = (post.querySelector(BODY)?.innerText ?? post.querySelector(BODY)?.textContent ?? '').trim();
    const ratedLength = Number(post.dataset.slopRadarLength) || 0;
    if (text.length < MIN_CHARS || text.length < ratedLength * REGROW) {
      if (ratedLength) visibility.unobserve(post); // re-observed by a click that did not grow the text
      return;
    }
    post.dataset.slopRadarLength = String(text.length);

    label(post, { state: 'pending' });
    let response;
    try {
      response = await ask(post, text);
    } catch (error) {
      if (error?.message === 'cancelled') return unlabel(post); // scrolled away before its turn; checked again on return
      if (error?.message === 'timeout') {
        post.dataset.slopRadarLength = '0'; // so scrolling past and back tries again
        return label(post, { state: 'error', message: 'Slop Radar took too long. Scroll past and back to try again.' });
      }
      // No runtime id means the extension was updated and this script is orphaned. Otherwise the
      // worker was asleep and the port closed before it answered; one more try after a moment.
      if (!chrome.runtime?.id) {
        return label(post, { state: 'error', message: 'Slop Radar was updated. Reload the page to rate posts again.' });
      }
      if (!retried) return setTimeout(() => recheck(post, true), RETRY_MS);
      post.dataset.slopRadarLength = '0';
      return label(post, { state: 'error', message: "Slop Radar didn't answer. Scroll past and back to try again." });
    }
    if (response?.retryAfter) {
      return setTimeout(() => recheck(post), Math.min(response.retryAfter, MAX_PAUSE_S) * 1000);
    }
    if (response?.code === 'no-key' || response?.code === 'bad-key') return pause(post, response.code);
    if (!response || response.error) {
      post.dataset.slopRadarLength = '0'; // tried again when it scrolls back into view
      return label(post, { state: 'error', message: response?.error ?? 'Rating failed.' });
    }
    label(post, { state: response.rating.verdict, rating: response.rating });
    // Rated: stop watching it scroll. A click on the post ("…more") brings it back for the re-rate check.
    visibility.unobserve(post);
    post.addEventListener('click', () => visibility.observe(post), { once: true });
  }

  // The worker rates one post at a time. It acknowledges a request at once, says when the post's turn
  // comes, and sends the result over the tab; the 30 s clock runs from the turn, not from queueing.
  let nextId = 0;
  const pending = new Map(); // id -> waiting request
  const waiting = new WeakMap(); // post -> its waiting request, to cancel if it scrolls away first

  function ask(post, text) {
    const id = (nextId += 1);
    return chrome.runtime.sendMessage({ type: 'rate', id, text }).then((ack) => {
      if (!ack?.queued) return ack; // answered on the spot
      return new Promise((resolve, reject) => {
        const fail = (why) => {
          clearTimeout(entry.timer);
          pending.delete(id);
          waiting.delete(post);
          reject(new Error(why));
        };
        const entry = {
          started: false,
          timer: setTimeout(() => fail('timeout'), QUEUE_TIMEOUT_MS),
          start() {
            entry.started = true;
            clearTimeout(entry.timer);
            entry.timer = setTimeout(() => fail('timeout'), REPLY_TIMEOUT_MS);
          },
          finish(result) {
            clearTimeout(entry.timer);
            pending.delete(id);
            waiting.delete(post);
            resolve(result);
          },
          cancel() {
            chrome.runtime.sendMessage({ type: 'cancel', id }).catch(() => {});
            fail('cancelled');
          },
        };
        pending.set(id, entry);
        waiting.set(post, entry);
      });
    });
  }

  /** A post scrolled out before the worker got to it: no point rating what nobody is looking at. */
  function left(post) {
    const entry = waiting.get(post);
    if (entry && !entry.started) entry.cancel();
  }

  /** Rates the post again as if it had just scrolled into view. */
  function recheck(post, retried = false) {
    post.dataset.slopRadarLength = '0';
    check(post, retried);
  }

  // No working key: one card at the top of the feed, not a "Not rated" tag on every post.

  let paused = false;
  const skipped = new Set(); // posts that came into view while paused
  let card = null;
  let dismissed = false;

  const MAX_SKIPPED = 40; // enough to cover the screen; older ones are scrolled away anyway
  const CARD_COPY = {
    'no-key': {
      text: "Slop Radar isn't connected yet.",
      button: 'Connect Jev',
      aside: 'Connecting takes two minutes and costs under a cent a week.',
    },
    'bad-key': {
      text: "Slop Radar's API key was rejected by the provider.",
      button: 'Check the key',
      aside: 'Posts stay unlabelled until it works.',
    },
  };

  function pause(post, code) {
    paused = true;
    unlabel(post);
    remember(post);
    if (!card && !dismissed) showCard(post, code);
  }

  /** Keeps the set of posts to rate on resume small on an infinite feed. */
  function remember(post) {
    for (const old of skipped) if (!old.isConnected) skipped.delete(old);
    skipped.add(post);
    while (skipped.size > MAX_SKIPPED) skipped.delete(skipped.values().next().value);
  }

  function unlabel(post) {
    const badge = post.querySelector(':scope > .slop-radar-badge');
    if (badge && current === badge) hide();
    badge?.remove();
    post.classList.remove('slop-radar-post');
    delete post.dataset.slopRadar;
    delete post.dataset.slopRadarLength;
  }

  function showCard(post, code) {
    const copy = CARD_COPY[code];
    card = document.createElement('div');
    card.className = 'slop-radar-card';
    const text = el('slop-radar-card-text', copy.text, 'p');
    text.append(' ', el('slop-radar-card-aside', copy.aside, 'span'));
    const connect = el('slop-radar-connect', copy.button, 'button');
    connect.type = 'button';
    connect.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-options' }).catch(() => {}));
    const dismiss = el('slop-radar-dismiss', undefined, 'button');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    dismiss.addEventListener('click', () => {
      dismissed = true;
      card.remove();
      card = null;
    });
    card.append(text, connect, dismiss);
    applyTheme(card);
    const first = document.querySelector(POST) ?? post;
    first.parentElement.insertBefore(card, first);
  }

  /** A key was saved: rate what was skipped, and anything left as "Not rated". */
  function resume() {
    paused = false;
    card?.remove();
    card = null;
    const stale = document.querySelectorAll('.slop-radar-post[data-slop-radar="error"]');
    for (const post of new Set([...skipped, ...stale])) recheck(post);
    skipped.clear();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'started') return pending.get(message.id)?.start();
    if (message?.type === 'rated') return pending.get(message.id)?.finish(message);
    if (message?.type !== 'status') return;
    if (message.connected) resume();
    else paused = true;
  });

  const pct = (p) => Math.round(p * 100);

  /** What screen readers hear; the popover shows the same thing visually. */
  function describe({ state, rating, message }) {
    if (state === 'pending') return 'Checking this post.';
    if (state === 'error') return `Not rated. ${message}`;
    const signals = rating.signals.length ? `Signals: ${rating.signals.join(', ')}.` : 'No strong signals.';
    return `${LABELS[state]}: ${pct(rating.slop)}% slop, ${pct(rating.human)}% human. ${signals}`;
  }

  /** Badge → what it currently says, for the popover. */
  const info = new WeakMap();

  /**
   * @param {HTMLElement} post
   * @param {{ state: 'slop' | 'human' | 'unclear' | 'pending' | 'error', rating?: any, message?: string }} data
   */
  function label(post, data) {
    // Only states this script knows get drawn; anything else is a reply we cannot show.
    if (!(data.state in GLYPHS)) data = { state: 'error', message: 'Unexpected reply from the provider.' };
    post.classList.add('slop-radar-post');
    post.dataset.slopRadar = data.state;
    applyTheme(post);
    let badge = post.querySelector(':scope > .slop-radar-badge');
    if (!badge) {
      // A button: it opens the popover, so it earns its tab stop, and touch users can tap it.
      badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'slop-radar-badge';
      badge.setAttribute('aria-expanded', 'false');
      badge.addEventListener('mouseenter', () => show(badge));
      badge.addEventListener('mouseleave', hideSoon);
      badge.addEventListener('focus', () => show(badge));
      badge.addEventListener('blur', hide);
      // Hover and focus open the popover on their own; a click pins it open (so it survives the pointer
      // leaving, and a tap on touch keeps it) and a second click closes it.
      badge.addEventListener('click', (event) => {
        event.stopPropagation(); // not a click on the post
        if (pinned === badge) return hide();
        show(badge);
        pinned = badge;
      });
      post.prepend(badge);
    }
    const fresh = !badge.dataset.slopRadar;
    badge.dataset.slopRadar = data.state;
    badge.innerHTML = glyph(data.state, 12);
    badge.append(Object.assign(document.createElement('span'), { textContent: LABELS[data.state] }));
    badge.setAttribute('aria-label', `Slop Radar. ${describe(data)}`);
    if (fresh) placeBadge(post, badge); // measured with its text in, once
    info.set(badge, data);
    if (current === badge) show(badge); // keep an open popover in step (Checking → verdict)
  }

  /**
   * The tag sits top-right, left of where LinkedIn's "…" menu usually is. Cards vary (Follow buttons,
   * wider menus), so measure the header's right-most control once and move further left if they meet.
   */
  function placeBadge(post, badge) {
    const header = [...post.children].find((el) => el !== badge && !el.matches(BODY) && !el.querySelector(BODY));
    const control = header?.lastElementChild;
    if (!control) return;
    const a = badge.getBoundingClientRect();
    const b = control.getBoundingClientRect();
    const apart = a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;
    if (!a.width || !b.width || apart) return;
    badge.style.right = `${post.getBoundingClientRect().right - b.left + 8}px`;
  }

  // Theme. LinkedIn's dark mode ignores the OS, so sample the card itself.

  let dark;
  function isDark(el) {
    for (let node = el; node; node = node.parentElement) {
      const [r, g, b, a = 1] = (getComputedStyle(node).backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
      // Plain weighted RGB, not linearised sRGB; plenty to tell LinkedIn's two themes apart.
      if (r !== undefined && a > 0) return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.2;
    }
    return false;
  }
  function applyTheme(post) {
    dark ??= isDark(post);
    if (dark) post.dataset.slopRadarTheme = 'dark';
    else delete post.dataset.slopRadarTheme;
  }
  new MutationObserver(() => {
    dark = undefined;
    document.querySelectorAll('.slop-radar-post, .slop-radar-card').forEach(applyTheme);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  // Popover: one shared element in a shadow root on <body>, so card overflow can't clip it.

  // Colours come from the --slop-radar-* properties content.css puts on :root, so they live in one place.
  const POPOVER_CSS = `
    :host { all: initial; }
    .pop { position: fixed; z-index: 2147483000; min-width: ${POPOVER_WIDTH}px; max-width: min(360px, calc(100vw - 16px));
      box-sizing: border-box; padding: 14px 16px;
      display: flex; flex-direction: column; gap: 12px; text-align: left;
      background: var(--slop-radar-cream); color: var(--slop-radar-ink); border-radius: 10px;
      border: 1px solid var(--slop-radar-line); box-shadow: var(--slop-radar-shadow);
      font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
    .pop[hidden] { display: none; }
    svg { display: block; flex: none; }
    .g-human { color: var(--slop-radar-human); } .g-slop { color: var(--slop-radar-slop); }
    .g-unclear, .g-pending, .g-error { color: var(--slop-radar-neutral); }
    .head { display: flex; align-items: center; gap: 8px; }
    .title { font-size: 15px; font-weight: 650; letter-spacing: -0.005em; }
    .brand { margin-left: auto; font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--slop-radar-muted); }
    .reading, .group { display: flex; flex-direction: column; gap: 6px; }
    .meter { display: flex; gap: 2px; height: 8px; }
    .meter div { flex-basis: 0; border-radius: 999px; outline: 1px solid rgb(46 43 37 / 40%); outline-offset: -1px; }
    .nums { display: flex; justify-content: space-between; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--slop-radar-muted); }
    .nums .h { color: var(--slop-radar-human-ink); font-weight: 600; } .nums .s { color: var(--slop-radar-slop-ink); font-weight: 600; }
    .signals { display: flex; flex-direction: column; gap: 8px; }
    .group { gap: 5px; }
    .group-title { font-size: 12px; font-weight: 600; color: var(--slop-radar-muted); }
    .sig { display: flex; align-items: center; gap: 8px; }
    .msg { color: var(--slop-radar-body); }
    .foot { padding-top: 10px; border-top: 1px solid var(--slop-radar-line); font-size: 12px; color: var(--slop-radar-muted); }
    @keyframes spin { to { transform: rotate(360deg); } }
    .slop-radar-spin { transform-origin: 6px 6px; animation: spin 1.2s linear infinite; }
    @media (prefers-reduced-motion: reduce) { .slop-radar-spin { animation: none; } }
  `;

  let pop;
  let current = null;
  let pinned = null; // the badge whose click is holding the popover open
  let hideTimer;

  function popover() {
    if (pop) return pop;
    const host = document.createElement('div');
    host.id = 'slop-radar-popover';
    host.setAttribute('aria-hidden', 'true'); // the tag's aria-label already says all of this
    // A click inside the popover must not move focus off the tag, or blur would close a pinned popover.
    host.addEventListener('mousedown', (event) => event.preventDefault());
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${POPOVER_CSS}</style><div class="pop" role="tooltip" hidden></div>`;
    pop = root.querySelector('.pop');
    pop.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    pop.addEventListener('mouseleave', hideSoon);
    document.body.append(host);
    return pop;
  }

  function show(badge) {
    clearTimeout(hideTimer);
    if (current && current !== badge) current.setAttribute('aria-expanded', 'false');
    current = badge;
    badge.setAttribute('aria-expanded', 'true');
    const el = popover();
    el.replaceChildren(...content(info.get(badge)));
    el.hidden = false;
    // 6px below the tag, right-aligned to it; flip above when there isn't room below.
    const rect = badge.getBoundingClientRect();
    const height = el.offsetHeight;
    const above = rect.top - 6 - height;
    el.style.top = `${rect.bottom + 6 + height > innerHeight && above >= 0 ? above : rect.bottom + 6}px`;
    el.style.left = `${Math.max(8, rect.right - (el.offsetWidth || POPOVER_WIDTH))}px`;
  }

  function hide() {
    clearTimeout(hideTimer);
    current?.setAttribute('aria-expanded', 'false');
    current = null;
    pinned = null;
    if (pop) pop.hidden = true;
  }

  function hideSoon() {
    if (pinned) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_GRACE_MS);
  }

  document.addEventListener('keydown', (event) => event.key === 'Escape' && hide());
  addEventListener('scroll', () => current && hide(), { passive: true, capture: true });

  const el = (className, text, tag = 'div') => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function content({ state, rating, message }) {
    const head = el('head');
    head.innerHTML = glyph(state, 16);
    head.append(el('title', TITLES[state]), el('brand', 'Slop Radar'));
    const parts = [head];

    if (rating) {
      const slop = pct(rating.slop);
      const human = pct(rating.human);
      const neither = Math.max(0, 100 - slop - human);
      // One meter, both sides: human grows from the left, slop from the right.
      const meter = el('meter');
      for (const [share, color] of [
        [human, 'var(--slop-radar-human-fill)'],
        [neither, 'var(--slop-radar-neither)'],
        [slop, 'var(--slop-radar-slop-fill)'],
      ]) {
        const seg = el('');
        Object.assign(seg.style, { flexGrow: share, minWidth: share ? '4px' : '0', background: color });
        meter.append(seg);
      }
      const nums = el('nums');
      nums.append(
        el('h', `${human}% human`, 'span'),
        el('', `${neither}% neither`, 'span'),
        el('s', `${slop}% slop`, 'span'),
      );
      const reading = el('reading');
      reading.append(meter, nums);

      const signals = el('signals');
      const toHuman = rating.signals.filter((s) => HUMAN_SIGNALS.includes(s));
      const toSlop = rating.signals.filter((s) => !HUMAN_SIGNALS.includes(s));
      for (const [title, list, side] of [
        ['Pointing to slop', toSlop, 'slop'],
        ['Pointing to human', toHuman, 'human'],
      ]) {
        if (!list.length) continue;
        const group = el('group');
        group.append(el('group-title', title));
        for (const signal of list) {
          const row = el('sig');
          row.innerHTML = glyph(side, 12);
          row.append(el('', signal, 'span'));
          group.append(row);
        }
        signals.append(group);
      }
      if (!rating.signals.length && state === 'unclear') {
        signals.append(
          el('msg', 'Nothing stood out either way, so neither side reached the 60% needed for a verdict.'),
        );
      }
      parts.push(reading);
      if (signals.childElementCount) parts.push(signals);
    } else {
      parts.push(el('msg', state === 'pending' ? 'Checking… usually under a second.' : message));
    }

    const foot = {
      pending: "Only the post's text is sent, never the author's name or profile.",
      error: 'Labels resume automatically when rating works again.',
    };
    parts.push(el('foot', foot[state] ?? 'Judges writing style, not who wrote it.'));
    return parts;
  }
})();
