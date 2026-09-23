/**
 * Rates a LinkedIn post: how much it reads like generic AI "slop", and which
 * telltale signals it shows. One Jev call per post, cached by text.
 *
 * @module lib/rating
 */

/** The questions asked about every post, in one call. */
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

/** Tooltip wording for each signal. */
export const SIGNALS = {
  hook: 'Generic hook',
  format: 'Broetry or emoji bullets',
  buzz: 'Stock AI phrasing',
  bait: 'Engagement bait',
  specific: 'Concrete first-hand details (a human sign)',
};

/** A side of the scale needs this much probability to decide the verdict. */
export const VERDICT_THRESHOLD = 0.6;
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
  const p = (level) => answers.slop.probabilities[level] ?? 0;
  const slop = p(3) + p(4);
  const human = p(0) + p(1);
  const verdict = slop >= VERDICT_THRESHOLD ? 'slop' : human >= VERDICT_THRESHOLD ? 'human' : 'unclear';
  const signals = Object.keys(SIGNALS)
    .filter((key) => answers[key]?.probability >= SIGNAL_THRESHOLD)
    .map((key) => SIGNALS[key]);
  return { verdict, slop, human, signals };
}

/**
 * Cache of ratings in extension storage, keyed by a hash of the post text and
 * trimmed to the most recent `max` entries.
 *
 * @param {{ get: (key: string) => Promise<Record<string, any>>, set: (items: Record<string, any>) => Promise<void> }} storage
 *   A `chrome.storage.local`-like area.
 * @param {{ max?: number, now?: () => number }} [options]
 */
export function createCache(storage, { max = 2000, now = () => Date.now() } = {}) {
  const KEY = 'ratings:v2'; // bump when the Rating shape changes
  return {
    /** @returns {Promise<Rating | undefined>} */
    async get(text) {
      const all = (await storage.get(KEY))[KEY] ?? {};
      return all[hash(text)]?.rating;
    },
    /** @param {string} text @param {Rating} rating */
    async set(text, rating) {
      const all = (await storage.get(KEY))[KEY] ?? {};
      all[hash(text)] = { rating, at: now() };
      const keys = Object.keys(all);
      if (keys.length > max) {
        keys
          .sort((a, b) => all[a].at - all[b].at)
          .slice(0, keys.length - max)
          .forEach((key) => delete all[key]);
      }
      await storage.set({ [KEY]: all });
    },
  };
}

/**
 * Rates posts one at a time (TypeSafe rate-limits bursts, and this runs
 * passively while scrolling), waiting out rate limits instead of failing.
 *
 * @param {object} deps
 * @param {import('./jev.js').JevClient} deps.jev
 * @param {ReturnType<typeof createCache>} deps.cache
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number} [deps.maxAttempts]
 */
export function createRater({ jev, cache, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxAttempts = 3 }) {
  let chain = Promise.resolve();

  async function rateNow(text) {
    const cached = await cache.get(text);
    if (cached) return cached;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const rating = toRating(await jev.evaluate({ state: text, questions: QUESTIONS }));
        await cache.set(text, rating);
        return rating;
      } catch (error) {
        if (!error.busy || attempt === maxAttempts) throw error;
        await sleep(Math.min(error.retryAfter || 5, 60) * 1000);
      }
    }
  }

  return {
    /** @param {string} text @returns {Promise<Rating>} */
    rate(text) {
      const result = chain.then(() => rateNow(text));
      chain = result.catch(() => {}); // one failure must not stall the queue
      return result;
    },
  };
}

/** djb2 hash, base-36. Stable across sessions; collisions are harmless (a re-rate). */
export function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = (h * 33) ^ text.charCodeAt(i);
  return (h >>> 0).toString(36);
}
