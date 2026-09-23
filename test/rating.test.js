import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JevError } from '../src/lib/jev.js';
import { QUESTIONS, SIGNALS, createCache, createRater, hash, toRating } from '../src/lib/rating.js';
import { fakeJev, yesNo } from './helpers.js';

/** Jev answers with a score distribution over the five levels, plus signal probabilities. */
const answers = (levels, signals = {}) => ({
  slop: {
    type: 'score',
    probabilities: Object.fromEntries(levels.map((p, i) => [String(i), p])),
    confidence: Math.max(...levels),
  },
  ...Object.fromEntries(Object.keys(SIGNALS).map((key) => [key, yesNo(signals[key] ?? 0)])),
});

/** An in-memory stand-in for chrome.storage.local. */
function memoryStorage() {
  const data = {};
  return {
    data,
    get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
    set: async (items) => Object.assign(data, structuredClone(items)),
  };
}

describe('toRating', () => {
  it('sums each side of the scale instead of trusting one level', () => {
    // 36% "clearly human" + 46% "mostly human": uncertain per level, but clearly human overall.
    const rating = toRating(answers([0.36, 0.46, 0.03, 0.15, 0]));
    assert.equal(rating.verdict, 'human');
    assert.ok(Math.abs(rating.human - 0.82) < 1e-9);
  });

  it('calls slop when the two slop levels reach the threshold', () => {
    assert.equal(toRating(answers([0.01, 0.1, 0.04, 0.54, 0.31])).verdict, 'slop');
  });

  it('is unclear when neither side reaches the threshold', () => {
    assert.equal(toRating(answers([0.2, 0.2, 0.2, 0.2, 0.2])).verdict, 'unclear');
  });

  it('lists the signals Jev is confident about', () => {
    const rating = toRating(answers([0, 0, 0, 0.1, 0.9], { hook: 0.95, bait: 0.7, buzz: 0.4 }));
    assert.deepEqual(rating.signals, [SIGNALS.hook, SIGNALS.bait]);
  });
});

describe('QUESTIONS', () => {
  it('asks one five-level score and one yes/no per signal', () => {
    assert.equal(QUESTIONS.slop.criteria.length, 5);
    for (const key of Object.keys(SIGNALS)) assert.equal(QUESTIONS[key].type, 'boolean');
  });
});

describe('createCache', () => {
  it('stores ratings by text', async () => {
    const cache = createCache(memoryStorage());
    await cache.set('post one', { verdict: 'human' });
    assert.deepEqual(await cache.get('post one'), { verdict: 'human' });
    assert.equal(await cache.get('post two'), undefined);
  });

  it('keeps only the most recent entries', async () => {
    let now = 0;
    const cache = createCache(memoryStorage(), { max: 2, now: () => (now += 1) });
    await cache.set('a', { verdict: 'human' });
    await cache.set('b', { verdict: 'slop' });
    await cache.set('c', { verdict: 'unclear' });
    assert.equal(await cache.get('a'), undefined);
    assert.deepEqual(await cache.get('c'), { verdict: 'unclear' });
  });
});

describe('createRater', () => {
  const slopAnswers = answers([0, 0, 0, 0.2, 0.8], { hook: 0.9 });

  it('rates with one Jev call and answers repeats from the cache', async () => {
    const jev = fakeJev(() => slopAnswers);
    const rater = createRater({ jev, cache: createCache(memoryStorage()) });
    const first = await rater.rate('Agree? Repost.');
    const again = await rater.rate('Agree? Repost.');
    assert.equal(first.verdict, 'slop');
    assert.deepEqual(again, first);
    assert.equal(jev.calls.length, 1);
    assert.equal(jev.calls[0].state, 'Agree? Repost.');
  });

  it('rates one post at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const jev = {
      async evaluate() {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return slopAnswers;
      },
    };
    const rater = createRater({ jev, cache: createCache(memoryStorage()) });
    await Promise.all(['a', 'b', 'c'].map((text) => rater.rate(text)));
    assert.equal(maxInFlight, 1);
  });

  it('waits out a rate limit and retries', async () => {
    const waits = [];
    let calls = 0;
    const jev = fakeJev(() => {
      calls += 1;
      if (calls === 1) throw new JevError('busy', { status: 429, retryAfter: 12 });
      return slopAnswers;
    });
    const rater = createRater({ jev, cache: createCache(memoryStorage()), sleep: async (ms) => waits.push(ms) });
    assert.equal((await rater.rate('post')).verdict, 'slop');
    assert.deepEqual(waits, [12_000]);
  });

  it('gives up after repeated rate limits, without blocking later posts', async () => {
    let fail = true;
    const jev = fakeJev(() => {
      if (fail) throw new JevError('busy', { status: 429, retryAfter: 1 });
      return slopAnswers;
    });
    const rater = createRater({ jev, cache: createCache(memoryStorage()), sleep: async () => {}, maxAttempts: 2 });
    await assert.rejects(rater.rate('first'), { status: 429 });
    fail = false;
    assert.equal((await rater.rate('second')).verdict, 'slop');
  });

  it('does not retry other errors', async () => {
    const jev = fakeJev(() => {
      throw new JevError('Your API key was rejected.', { status: 401 });
    });
    const rater = createRater({ jev, cache: createCache(memoryStorage()), sleep: async () => assert.fail('no wait') });
    await assert.rejects(rater.rate('post'), { status: 401 });
    assert.equal(jev.calls.length, 1);
  });
});

describe('hash', () => {
  it('is stable and distinguishes texts', () => {
    assert.equal(hash('hello'), hash('hello'));
    assert.notEqual(hash('hello'), hash('hello!'));
  });
});
