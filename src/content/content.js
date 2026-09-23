/**
 * LinkedIn content script: finds feed posts as they scroll into view, asks the
 * service worker to rate each one, and labels the post with the verdict.
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

  const LABELS = { slop: 'AI slop', human: 'Human', unclear: 'Unclear', pending: 'Checking', error: 'Not rated' };

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

  async function check(post) {
    const text = (post.querySelector(BODY)?.innerText ?? post.querySelector(BODY)?.textContent ?? '').trim();
    const ratedLength = Number(post.dataset.slopRadarLength) || 0;
    if (text.length < MIN_CHARS || text.length < ratedLength * REGROW) return;
    post.dataset.slopRadarLength = String(text.length);

    label(post, 'pending', 'Slop Radar is checking this post.');
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'rate', text });
    } catch {
      response = { error: 'Slop Radar was updated. Reload the page to rate posts again.' };
    }
    if (!response || response.error) return label(post, 'error', response?.error ?? 'Rating failed.');

    const { verdict, slop, human, signals } = response.rating;
    const detail = [
      `${LABELS[verdict]}: ${Math.round(slop * 100)}% slop, ${Math.round(human * 100)}% human.`,
      signals.length ? `Signals: ${signals.join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
    label(post, verdict, detail);
  }

  /**
   * @param {HTMLElement} post
   * @param {'slop' | 'human' | 'unclear' | 'pending' | 'error'} state
   * @param {string} detail Shown on hover and read by screen readers.
   */
  function label(post, state, detail) {
    post.classList.add('slop-radar-post');
    post.dataset.slopRadar = state;
    let badge = post.querySelector(':scope > .slop-radar-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'slop-radar-badge';
      badge.tabIndex = 0;
      badge.setAttribute('role', 'note');
      post.prepend(badge);
    }
    badge.textContent = LABELS[state];
    badge.title = detail;
    badge.setAttribute('aria-label', `Slop Radar. ${detail}`);
  }
})();
