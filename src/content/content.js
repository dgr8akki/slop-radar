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
  const POST = '[componentkey^="update-card"]';
  const BODY = '[data-testid="expandable-text-box"]';
  const MIN_CHARS = 80; // too short to judge (reposts, one-liners)
  const REGROW = 1.3; // re-rate when "… more" reveals 30% more text
  const SCAN_MS = 1500;
  const HIDE_GRACE_MS = 150; // lets the pointer travel from the tag into the popover
  const RETRY_MS = 1000; // a worker woken by the message sometimes drops that first reply
  const MAX_PAUSE_S = 60; // longest the page waits on a provider pause before asking again
  const POPOVER_WIDTH = 288;
  const HUMAN_SIGNALS = ['Concrete first-hand details']; // SIGNALS.specific in lib/rating.js

  const LABELS = { slop: 'AI slop', human: 'Human', unclear: 'Unclear', pending: 'Checking', error: 'Not rated' };
  const TITLES = {
    slop: 'Reads like AI slop',
    human: 'Reads human',
    unclear: 'Could go either way',
    pending: 'Checking',
    error: 'Not rated',
  };

  /** One glyph per state, so the tag never relies on colour alone. 12×12 viewBox. */
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
      for (const entry of entries) if (entry.isIntersecting) check(entry.target);
    },
    { threshold: 0.4 },
  );

  // The feed is infinite and re-rendered by React, so rescan rather than trust mutation paths.
  function scan() {
    for (const post of document.querySelectorAll(POST)) {
      if (observed.has(post)) continue;
      observed.add(post);
      visibility.observe(post);
    }
  }
  scan();
  setInterval(scan, SCAN_MS);

  async function check(post, retried = false) {
    if (paused) return skipped.add(post); // rated when a key arrives; see resume()
    const text = (post.querySelector(BODY)?.innerText ?? post.querySelector(BODY)?.textContent ?? '').trim();
    const ratedLength = Number(post.dataset.slopRadarLength) || 0;
    if (text.length < MIN_CHARS || text.length < ratedLength * REGROW) return;
    post.dataset.slopRadarLength = String(text.length);

    label(post, { state: 'pending' });
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'rate', text });
    } catch {
      // No runtime id means the extension was updated and this script is orphaned. Otherwise the
      // worker was asleep and the port closed before it answered; one more try after a moment.
      if (!chrome.runtime?.id) {
        return label(post, { state: 'error', message: 'Slop Radar was updated. Reload the page to rate posts again.' });
      }
      if (!retried) return setTimeout(() => recheck(post, true), RETRY_MS);
      post.dataset.slopRadarLength = '0'; // so scrolling past and back tries again
      return label(post, { state: 'error', message: "Slop Radar didn't answer. Scroll past and back to try again." });
    }
    if (response?.retryAfter) {
      return setTimeout(() => recheck(post), Math.min(response.retryAfter, MAX_PAUSE_S) * 1000);
    }
    if (response?.code === 'no-key' || response?.code === 'bad-key') return pause(post, response.code);
    if (!response || response.error)
      return label(post, { state: 'error', message: response?.error ?? 'Rating failed.' });
    label(post, { state: response.rating.verdict, rating: response.rating });
  }

  /** Rates the post again as if it had just scrolled into view. */
  function recheck(post, retried = false) {
    post.dataset.slopRadarLength = '0';
    check(post, retried);
  }

  // — No working key: one card at the top of the feed, not a "Not rated" tag on every post. —

  let paused = false;
  const skipped = new Set(); // posts that came into view while paused
  let card = null;
  let dismissed = false;

  const CARD_COPY = {
    'no-key': {
      text: "Slop Radar isn't connected yet.",
      button: 'Connect Jev',
      aside: 'two minutes, costs under a cent a week.',
    },
    'bad-key': {
      text: "Slop Radar's API key was rejected by the provider.",
      button: 'Check the key',
      aside: 'posts stay unlabelled until it works.',
    },
  };

  function pause(post, code) {
    paused = true;
    unlabel(post);
    skipped.add(post);
    if (!card && !dismissed) showCard(post, code);
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
    post.classList.add('slop-radar-post');
    post.dataset.slopRadar = data.state;
    applyTheme(post);
    let badge = post.querySelector(':scope > .slop-radar-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'slop-radar-badge';
      badge.tabIndex = 0;
      badge.setAttribute('role', 'note');
      badge.addEventListener('mouseenter', () => show(badge));
      badge.addEventListener('mouseleave', hideSoon);
      badge.addEventListener('focus', () => show(badge));
      badge.addEventListener('blur', hide);
      post.prepend(badge);
    }
    badge.dataset.slopRadar = data.state;
    badge.innerHTML = glyph(data.state, 12);
    badge.append(Object.assign(document.createElement('span'), { textContent: LABELS[data.state] }));
    badge.setAttribute('aria-label', `Slop Radar. ${describe(data)}`);
    info.set(badge, data);
    if (current === badge) show(badge); // keep an open popover in step (Checking → verdict)
  }

  // — Theme. LinkedIn's dark mode ignores the OS, so sample the card itself. —

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

  // — Popover: one shared element in a shadow root on <body>, so card overflow can't clip it. —

  const POPOVER_CSS = `
    :host { all: initial; }
    .pop { position: fixed; z-index: 2147483000; width: ${POPOVER_WIDTH}px; box-sizing: border-box; padding: 14px 16px;
      display: flex; flex-direction: column; gap: 12px; text-align: left;
      background: #f9f4ed; color: #201e1d; border-radius: 20px;
      box-shadow: 0 12px 32px rgb(46 43 37 / 28%), 0 0 0 1px rgb(46 43 37 / 8%);
      font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
    .pop[hidden] { display: none; }
    svg { display: block; flex: none; }
    .g-human { color: #728157; } .g-slop { color: #b2622d; } .g-unclear, .g-pending, .g-error { color: #82796a; }
    .head { display: flex; align-items: center; gap: 8px; }
    .title { font-size: 15px; font-weight: 650; letter-spacing: -0.005em; }
    .brand { margin-left: auto; font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #645c50; }
    .reading, .group { display: flex; flex-direction: column; gap: 6px; }
    .meter { display: flex; gap: 2px; height: 8px; }
    .meter div { flex-basis: 0; border-radius: 999px; }
    .nums { display: flex; justify-content: space-between; font-size: 12px; font-variant-numeric: tabular-nums; color: #645c50; }
    .nums .h { color: #3d472b; font-weight: 600; } .nums .s { color: #643312; font-weight: 600; }
    .signals { display: flex; flex-direction: column; gap: 8px; }
    .group { gap: 5px; }
    .group-title { font-size: 11px; font-weight: 600; color: #645c50; }
    .sig { display: flex; align-items: center; gap: 8px; }
    .msg { color: #474238; }
    .foot { padding-top: 10px; border-top: 1px solid rgb(46 43 37 / 12%); font-size: 11.5px; color: #645c50; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .slop-radar-spin { transform-origin: 6px 6px; animation: spin 1.2s linear infinite; }
    @media (prefers-reduced-motion: reduce) { .slop-radar-spin { animation: none; } }
  `;

  let pop;
  let current = null;
  let hideTimer;

  function popover() {
    if (pop) return pop;
    const host = document.createElement('div');
    host.id = 'slop-radar-popover';
    host.setAttribute('aria-hidden', 'true'); // the tag's aria-label already says all of this
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
    current = badge;
    const el = popover();
    el.replaceChildren(...content(info.get(badge)));
    el.hidden = false;
    // 6px below the tag, right-aligned to it; flip above when there isn't room below.
    const rect = badge.getBoundingClientRect();
    const height = el.offsetHeight;
    const above = rect.top - 6 - height;
    el.style.top = `${rect.bottom + 6 + height > innerHeight && above >= 0 ? above : rect.bottom + 6}px`;
    el.style.left = `${Math.max(8, rect.right - POPOVER_WIDTH)}px`;
  }

  function hide() {
    clearTimeout(hideTimer);
    current = null;
    if (pop) pop.hidden = true;
  }

  function hideSoon() {
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
        [human, '#8fa073'],
        [neither, '#dcd3c4'],
        [slop, '#d67f48'],
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
      parts.push(
        el(
          'msg',
          state === 'pending'
            ? 'Reading this post’s text. Usually under a second, a few seconds when the provider is busy.'
            : message,
        ),
      );
    }

    const foot = {
      pending: "Only the post's text is sent, never the author's name or profile.",
      error: 'Nothing is labelled until rating works again.',
    };
    parts.push(el('foot', foot[state] ?? 'Judges writing style, not who wrote it.'));
    return parts;
  }
})();
