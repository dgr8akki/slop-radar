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

/** An in-memory stand-in for chrome.storage.local, counting round trips. */
function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  const calls = { get: 0, set: 0, remove: 0 };
  return {
    data,
    calls,
    async get(key) {
      calls.get += 1;
      if (key === null) return structuredClone(data);
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      calls.set += 1;
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      calls.remove += 1;
      for (const key of [keys].flat()) delete data[key];
    },
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

  it('rejects a reply whose shape has drifted instead of reading undefined', () => {
    const drift = { name: 'JevError', message: 'Unexpected reply from the provider.' };
    const good = answers([0, 0, 0, 0.1, 0.9]);
    assert.throws(() => toRating(undefined), drift);
    assert.throws(() => toRating({}), drift);
    assert.throws(() => toRating({ ...good, slop: undefined }), drift);
    assert.throws(() => toRating({ ...good, slop: { type: 'score' } }), drift);
    assert.throws(() => toRating({ ...good, slop: { type: 'score', probabilities: 'high' } }), drift);
    assert.throws(() => toRating({ ...good, hook: undefined }), drift);
    assert.throws(() => toRating({ ...good, bait: { type: 'boolean' } }), drift);
    assert.ok(toRating(good) instanceof Object);
  });
});

describe('QUESTIONS', () => {
  it('asks one five-level score and one yes/no per signal', () => {
    assert.equal(QUESTIONS.slop.criteria.length, 5);
    for (const key of Object.keys(SIGNALS)) assert.equal(QUESTIONS[key].type, 'boolean');
  });
});

describe('createCache', () => {
  it('stores ratings by text: hit and miss', async () => {
    const cache = createCache(memoryStorage());
    await cache.set('post one', { verdict: 'human' });
    assert.deepEqual(await cache.get('post one'), { verdict: 'human' });
    assert.equal(await cache.get('post two'), undefined);
  });

  it('writes one small entry per post instead of rewriting the whole map', async () => {
    const storage = memoryStorage();
    const cache = createCache(storage);
    await cache.set('post one', { verdict: 'human' });
    await cache.set('post two', { verdict: 'slop' });
    const keys = Object.keys(storage.data);
    assert.equal(keys.length, 2);
    // The key carries the text length: a 32-bit hash collision then also needs equal-length texts.
    assert.ok(keys.includes(`ratings:v4:${hash('post one')}:8`), keys.join());
    for (const key of keys) assert.deepEqual(Object.keys(storage.data[key]), ['rating', 'at']);
  });

  it('trims to the most recent entries in batches, not on every write', async () => {
    let now = 0;
    const storage = memoryStorage();
    const cache = createCache(storage, { max: 2, trimEvery: 3, now: () => (now += 1) });
    await cache.set('a', { verdict: 'human' });
    await cache.set('b', { verdict: 'slop' });
    assert.equal(storage.calls.remove, 1, 'the old single-blob cache is cleared once');
    assert.equal(storage.calls.get, 1, 'one full read on the first write, none on the second');
    await cache.set('c', { verdict: 'unclear' }); // third write: trim
    assert.equal(await cache.get('a'), undefined);
    assert.deepEqual(await cache.get('b'), { verdict: 'slop' });
    assert.deepEqual(await cache.get('c'), { verdict: 'unclear' });
    assert.equal(Object.keys(storage.data).length, 2);
  });

  it('trims on its first write, so a short-lived worker still enforces the cap', async () => {
    const full = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`ratings:v4:k${i}:9`, { rating: { verdict: 'slop' }, at: i }]),
    );
    const storage = memoryStorage(full);
    const cache = createCache(storage, { max: 3, trimEvery: 50, now: () => 100 });
    await cache.set('fresh post', { verdict: 'human' });
    const keys = Object.keys(storage.data);
    assert.equal(keys.length, 3);
    assert.ok(keys.includes('ratings:v4:k4:9') && !keys.includes('ratings:v4:k0:9'), 'oldest went first');
    assert.deepEqual(await cache.get('fresh post'), { verdict: 'human' });
  });

  it('starts clean: drops the old single-blob cache and leaves other keys alone', async () => {
    const storage = memoryStorage({ 'ratings:v3': { x: { rating: { verdict: 'slop' }, at: 1 } }, apiKey: 'vck_1' });
    const cache = createCache(storage);
    assert.equal(await cache.get('anything'), undefined);
    assert.deepEqual(Object.keys(storage.data), ['apiKey']);
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

  it('hands long rate limits back instead of sleeping through them in the worker', async () => {
    // Chrome stops an idle worker after ~30 s, taking the pending reply with it.
    const jev = fakeJev(() => {
      throw new JevError('busy', { status: 429, retryAfter: 30 });
    });
    const rater = createRater({ jev, cache: createCache(memoryStorage()), sleep: async () => assert.fail('no wait') });
    await assert.rejects(rater.rate('first'), { status: 429, retryAfter: 30 });
    // Later posts fail fast for the pause window rather than each paying the full retry budget.
    await assert.rejects(rater.rate('second'), { status: 429, retryAfter: 30 });
    assert.equal(jev.calls.length, 2);

    const waits = [];
    const capped = createRater({
      jev,
      cache: createCache(memoryStorage()),
      sleep: async (ms) => waits.push(ms),
      maxWaitMs: 40_000,
      maxAttempts: 2,
    });
    await assert.rejects(capped.rate('third'), { status: 429 });
    assert.deepEqual(waits, [30_000], 'waits when the cap allows it');
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

  it('remembers a rejected or missing key for a minute instead of asking the provider per post', async () => {
    let now = 0;
    const jev = fakeJev(() => {
      throw new JevError('Your API key was rejected. Check it in settings.', { status: 401 });
    });
    const cache = createCache(memoryStorage());
    await cache.set('seen before', { verdict: 'human', slop: 0.1, human: 0.8, signals: [] });
    const rater = createRater({ jev, cache, now: () => now });

    await assert.rejects(rater.rate('first'), { status: 401 });
    await assert.rejects(rater.rate('second'), { status: 401, message: /rejected/ });
    assert.equal(jev.calls.length, 1, 'the second post did not reach the provider');
    assert.equal((await rater.rate('seen before')).verdict, 'human', 'cached ratings are still served');

    now = 61_000;
    await assert.rejects(rater.rate('third'), { status: 401 });
    assert.equal(jev.calls.length, 2, 'asked again once the minute was up');

    rater.reset(); // the key changed in settings
    await assert.rejects(rater.rate('fourth'), { status: 401 });
    assert.equal(jev.calls.length, 3);
  });

  it("tells the caller when a post's turn comes, and skips one cancelled while it waited", async () => {
    const jev = fakeJev(() => slopAnswers);
    const rater = createRater({ jev, cache: createCache(memoryStorage()) });
    const order = [];
    const first = rater.rate('first', { onStart: () => order.push('start first') });
    const dropped = new AbortController();
    const second = rater.rate('second', { signal: dropped.signal, onStart: () => order.push('start second') });
    const third = rater.rate('third', { onStart: () => order.push('start third') });
    dropped.abort();
    await first;
    await assert.rejects(second, { name: 'AbortError' });
    await third;
    assert.deepEqual(order, ['start first', 'start third']);
    assert.deepEqual(
      jev.calls.map((c) => c.state),
      ['first', 'third'],
    );
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
