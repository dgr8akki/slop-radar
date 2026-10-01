// Rates a LinkedIn post: how much it reads like generic AI "slop", and which signals it shows.
// One Jev call per post, cached by text.

import { JevError } from './jev.js';

export const QUESTIONS = {
  slop: {
    type: 'score',
    instructions:
      'How much does this LinkedIn post read like generic AI-generated "slop" rather than something a person actually wrote?',
    criteria: [
      'Clearly human: specific, first-hand, uneven natural voice',
      'Mostly human, maybe lightly polished',
      'Unclear or mixed',
      'Likely AI-written: templated structure, generic insight',
      'Obvious AI slop: formulaic hook, one-line "broetry", buzzwords, empty engagement bait',
    ],
  },
  hook: { type: 'boolean', instructions: 'Does it open with a generic attention-grabbing hook or cliffhanger line?' },
  format: {
    type: 'boolean',
    instructions: 'Is it formatted as one-sentence-per-line "broetry" or emoji/arrow bullet lists?',
  },
  buzz: {
    type: 'boolean',
    instructions:
      'Does it use stock AI phrasing (e.g. "here\'s the thing", "game-changer", "it\'s not X, it\'s Y", "in today\'s fast-paced world", "let that sink in")?',
  },
  bait: {
    type: 'boolean',
    instructions:
      'Does it end with engagement bait ("Agree?", "Thoughts?", "Repost if…", "Comment X and I\'ll send…")?',
  },
  specific: {
    type: 'boolean',
    instructions:
      'Does it include first-hand details a template could not produce (named people or companies, exact technical details, real events)? A dramatic number in a hook ("rejected from 47 jobs") does not count.',
  },
};

export const SIGNALS = {
  hook: 'Generic hook',
  format: 'Broetry or emoji bullets',
  buzz: 'Stock AI phrasing',
  bait: 'Engagement bait',
  specific: 'Concrete first-hand details', // content.js groups this one under "Pointing to human"
};

export const VERDICT_THRESHOLD = 0.6; // share one side must hold before the tag commits
const SIGNAL_THRESHOLD = 0.6;

/**
 * @typedef {object} Rating
 * @property {'slop' | 'human' | 'unclear'} verdict
 * @property {number} slop Probability on the two slop levels (0-1).
 * @property {number} human Probability on the two human levels (0-1).
 * @property {string[]} signals Descriptions of the signals that fired.
 */

/**
 * Sums each side of the five-level scale. Jev's own `confidence` describes a
 * single level, so a post split between "clearly" and "mostly" human would
 * look uncertain even at 80% human; the sides are what matter here.
 *
 * @param {Record<string, any>} answers
 * @returns {Rating}
 */
export function toRating(answers) {
  // Read nothing until the shape is checked: a changed API or a proxy's stand-in body must not
  // surface as a TypeError from deep inside this function.
  const isRecord = (value) => typeof value === 'object' && value !== null;
  const shaped =
    isRecord(answers) &&
    isRecord(answers.slop?.probabilities) &&
    Object.keys(SIGNALS).every((key) => typeof answers[key]?.probability === 'number');
  if (!shaped) throw new JevError('Unexpected reply from the provider.');

  const p = (level) => answers.slop.probabilities[level] ?? 0;
  const slop = p(3) + p(4);
  const human = p(0) + p(1);
  const verdict = slop >= VERDICT_THRESHOLD ? 'slop' : human >= VERDICT_THRESHOLD ? 'human' : 'unclear';
  const signals = Object.keys(SIGNALS)
    .filter((key) => answers[key]?.probability >= SIGNAL_THRESHOLD)
    .map((key) => SIGNALS[key]);
  return { verdict, slop, human, signals };
}

// Ratings in extension storage (`storage` looks like chrome.storage.local): one small entry per post,
// trimmed every `trimEvery` writes to the most recent `max`, so the cap is approximate by that much.
export function createCache(storage, { max = 2000, trimEvery = 50, now = () => Date.now() } = {}) {
  const PREFIX = 'ratings:v4:'; // bump when the Rating shape, signal wording or storage layout changes
  const LEGACY = 'ratings:v3'; // every rating in one object; rewriting it per post cost ~200 KB twice
  // The length rules out the other post in a 32-bit collision, which would otherwise show its verdict.
  const key = (text) => `${PREFIX}${hash(text)}:${text.length}`;
  let writes = 0;
  let cleaned;

  // Once per worker life: the old layout is not read, just removed.
  const clean = () => (cleaned ??= storage.remove(LEGACY));

  async function trim() {
    const entries = Object.entries(await storage.get(null)).filter(([k]) => k.startsWith(PREFIX));
    if (entries.length <= max) return;
    const oldest = entries.sort((a, b) => a[1].at - b[1].at).slice(0, entries.length - max);
    await storage.remove(oldest.map(([k]) => k));
  }

  return {
    /** @returns {Promise<Rating | undefined>} */
    async get(text) {
      await clean();
      const k = key(text);
      return (await storage.get(k))[k]?.rating;
    },
    /** @param {string} text @param {Rating} rating */
    async set(text, rating) {
      await clean();
      await storage.set({ [key(text)]: { rating, at: now() } });
      // The counter lives in worker memory, so a worker that dies young would never trim: the first
      // write of each worker life trims too.
      writes += 1;
      if (writes === 1 || writes % trimEvery === 0) await trim();
    },
  };
}

// Rates posts one at a time (the provider rate-limits bursts, and this runs while scrolling). Short
// rate limits are waited out here, up to `maxWaitMs` in total per post; beyond that the error is thrown
// with `retryAfter` so the caller can come back. A 401 is remembered for `authPauseMs` so a feed of posts costs one round trip.
export function createRater({
  jev,
  cache,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxAttempts = 3,
  maxWaitMs = 8_000,
  authPauseMs = 60_000,
  now = () => Date.now(),
}) {
  let chain = Promise.resolve();
  let auth = null; // { error, until }: the last 401, so a feed of posts costs one round trip, not one each

  async function rateNow(text) {
    const cached = await cache.get(text);
    if (cached) return cached;
    if (auth && now() < auth.until) throw auth.error;
    let waited = 0;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const rating = toRating(await jev.evaluate({ state: text, questions: QUESTIONS }));
        await cache.set(text, rating);
        return rating;
      } catch (error) {
        if (error.status === 401) auth = { error, until: now() + authPauseMs };
        // Sleeping here holds up every post behind this one and the page's own clock, so the total per
        // post is capped; past it the error carries retryAfter and the page asks again later.
        const waitMs = (error.retryAfter || 5) * 1000;
        if (!error.busy || attempt === maxAttempts || waited + waitMs > maxWaitMs) throw error;
        waited += waitMs;
        await sleep(waitMs);
      }
    }
  }

  return {
    /**
     * @param {string} text
     * @param {{ signal?: AbortSignal, onStart?: () => void }} [options]
     *   `signal`: abort while queued and the post is skipped with an AbortError once its turn comes.
     *   `onStart`: called when the post's turn comes, so a caller can time the request, not the queue.
     * @returns {Promise<Rating>}
     */
    rate(text, { signal, onStart } = {}) {
      const result = chain.then(() => {
        if (signal?.aborted) throw Object.assign(new Error('Rating cancelled.'), { name: 'AbortError' });
        onStart?.();
        return rateNow(text);
      });
      chain = result.catch(() => {}); // a rejected rating must not hold up the post behind it
      return result;
    },
    /** Forgets a remembered key failure; call when the key or provider changes. */
    reset() {
      auth = null;
    },
  };
}

/** djb2 hash, base-36. Stable across sessions. 32 bits collide now and then, so cache keys add the text length. */
export function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = (h * 33) ^ text.charCodeAt(i);
  return (h >>> 0).toString(36);
}
