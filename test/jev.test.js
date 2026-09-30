import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JevError, PROVIDERS, createJevClient, maskKey } from '../src/lib/jev.js';
import { response } from './helpers.js';

const body = { state: 'ping', questions: { ok: { type: 'boolean', instructions: 'Test?' } } };

/** Client whose fetch replies with `replies` in order and records requests. */
function client(replies, { key = 'vck_test', provider, now = () => 0, timeoutMs } = {}) {
  const requests = [];
  const sleeps = [];
  const jev = createJevClient({
    getKey: () => key,
    getProvider: () => provider,
    now,
    timeoutMs,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  return { jev, requests, sleeps };
}

describe('createJevClient', () => {
  it('posts the model, state and questions with the key to Vercel by default', async () => {
    const { jev, requests } = client([response(200, { answers: { ok: { probability: 1 } } })]);
    assert.deepEqual(await jev.evaluate(body), { ok: { probability: 1 } });
    assert.equal(requests[0].url, 'https://ai-gateway.vercel.sh/v1/evaluate');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer vck_test');
    assert.deepEqual(JSON.parse(requests[0].init.body), { model: 'typesafe-ai/jev', ...body });
  });

  it('calls TypeSafe directly with its own model name', async () => {
    const { jev, requests } = client([response(200, { answers: { ok: { probability: 1 } } })], {
      key: 'ts_test',
      provider: 'typesafe',
    });
    await jev.evaluate(body);
    assert.equal(requests[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(requests[0].init.headers.Authorization, 'Bearer ts_test');
    assert.equal(JSON.parse(requests[0].init.body).model, 'jev-latest');
  });

  it("explains TypeSafe's 403 for a bad key, and its budget errors", async () => {
    const rejected = response(403, {
      detail: { error_type: 'authentication_error', message: 'Cannot authenticate with the server.' },
    });
    await assert.rejects(client([rejected], { provider: 'typesafe' }).jev.evaluate(body), {
      status: 401,
      message: /key was rejected/,
    });
    await assert.rejects(client([response(402, {})], { provider: 'typesafe' }).jev.evaluate(body), {
      message: PROVIDERS.typesafe.budgetMessage,
    });
  });

  it('translates yes/no questions to and from TypeSafe noul', async () => {
    const { jev, requests } = client([response(200, { answers: { ok: { type: 'noul', noul: 0.8 } } })], {
      provider: 'typesafe',
    });
    assert.deepEqual(await jev.evaluate(body), { ok: { type: 'boolean', probability: 0.8 } });
    assert.equal(JSON.parse(requests[0].init.body).questions.ok.type, 'noul');
  });

  it('exposes evaluate and nothing else', () => {
    assert.deepEqual(Object.keys(createJevClient({ getKey: () => '' })), ['evaluate']);
  });

  it('masks keys to their ends', () => {
    assert.equal(maskKey('vck_abcdefghijklmnop1234'), 'vck_…1234');
    assert.equal(maskKey('short'), '••••');
  });

  it("passes TypeSafe's other errors through in its words", async () => {
    const reply = response(422, { detail: { error_type: 'invalid_request', message: 'Too many questions.' } });
    await assert.rejects(client([reply], { provider: 'typesafe' }).jev.evaluate(body), {
      status: 422,
      message: 'Too many questions.',
    });
  });

  it('asks for a key before calling the network', async () => {
    const { jev, requests } = client([], { key: '  ' });
    await assert.rejects(jev.evaluate(body), { name: 'JevError', status: 401, message: /Add your API key/ });
    assert.equal(requests.length, 0);
  });

  it('turns a failed fetch into a JevError that names the host', async () => {
    const offline = new TypeError('Failed to fetch');
    const error = await client([offline])
      .jev.evaluate(body)
      .catch((e) => e);
    assert.ok(error instanceof JevError, 'not a JevError');
    assert.equal(error.status, 0);
    assert.equal(error.message, "Can't reach ai-gateway.vercel.sh. Check your connection and try again.");
    assert.equal(error.cause, offline);

    const typesafe = await client([new TypeError('Failed to fetch')], { provider: 'typesafe' })
      .jev.evaluate(body)
      .catch((e) => e);
    assert.match(typesafe.message, /Can't reach api.typesafe.ai/);
  });

  it('gives up on a request after the timeout', async () => {
    const { jev, requests } = client([response(200, { answers: { ok: { probability: 1 } } })]);
    await jev.evaluate(body);
    assert.ok(requests[0].init.signal instanceof AbortSignal, 'no abort signal on the request');
    assert.equal(requests[0].init.signal.aborted, false);

    // A fetch that only settles once its signal fires, as the real one does. Node's AbortSignal.timeout
    // timer is unref'd and would let the process exit first, so hold the loop open until then.
    const hung = createJevClient({
      getKey: () => 'vck_test',
      timeoutMs: 5,
      fetchImpl: (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          const hold = setTimeout(() => {}, 1_000);
          signal.addEventListener('abort', () => {
            clearTimeout(hold);
            reject(signal.reason);
          });
        }),
    });
    const error = await hung.evaluate(body).catch((e) => e);
    assert.ok(error instanceof JevError, 'not a JevError');
    assert.equal(error.status, 0);
    assert.equal(error.message, 'ai-gateway.vercel.sh took too long to answer. Try again.');
    assert.equal(error.cause.name, 'TimeoutError');
  });

  it('retries a server error once, after a short pause', async () => {
    const { jev, requests, sleeps } = client([response(503, {}), response(200, { answers: { ok: {} } })]);
    assert.deepEqual(await jev.evaluate(body), { ok: {} });
    assert.equal(requests.length, 2);
    assert.equal(sleeps.length, 1, 'one pause between the two attempts');
    assert.ok(sleeps[0] >= 300 && sleeps[0] <= 500, `paused ${sleeps[0]} ms`);
  });

  it('does not pause when the first attempt succeeds', async () => {
    const { jev, sleeps } = client([response(200, { answers: { ok: {} } })]);
    await jev.evaluate(body);
    assert.deepEqual(sleeps, []);
  });

  it('surfaces a second server error', async () => {
    const { jev } = client([response(503, {}), response(503, { error: { message: 'Service unavailable' } })]);
    await assert.rejects(jev.evaluate(body), { status: 503, message: 'Service unavailable' });
  });

  it('copes with error bodies that are not JSON objects', async () => {
    const { jev } = client([response(503, 'Service Unavailable'), response(503, null)]);
    await assert.rejects(jev.evaluate(body), { name: 'JevError', status: 503, message: /HTTP 503/ });
  });

  it('pauses after a rate limit and refuses calls until Retry-After passes', async () => {
    let now = 0;
    const { jev, requests } = client(
      [response(429, {}, { 'retry-after': '20' }), response(200, { answers: { ok: { probability: 1 } } })],
      { now: () => now },
    );

    const error = await jev.evaluate(body).catch((e) => e);
    assert.ok(error instanceof JevError && error.busy);
    assert.equal(error.retryAfter, 20);

    now = 5_000;
    await assert.rejects(jev.evaluate(body), { status: 429, message: /15s/ });
    assert.equal(requests.length, 1, 'no request while paused');

    now = 20_000;
    assert.deepEqual(await jev.evaluate(body), { ok: { probability: 1 } });
  });

  it('rejects a 200 that does not answer the questions', async () => {
    // A proxy or captive portal can answer 200 with anything; accepting {} as "answers" made the
    // options pages save such a key as working.
    const unexpected = { name: 'JevError', status: 200, message: 'Unexpected reply from ai-gateway.vercel.sh.' };
    await assert.rejects(client([response(200, {})]).jev.evaluate(body), unexpected);
    await assert.rejects(client([response(200, { answers: {} })]).jev.evaluate(body), unexpected);
    await assert.rejects(client([response(200, { answers: 'yes' })]).jev.evaluate(body), unexpected);

    const html = { ...response(200, null), json: async () => JSON.parse('<!doctype html>') };
    await assert.rejects(client([html]).jev.evaluate(body), unexpected);
  });

  it('explains rejected keys and exhausted budgets', async () => {
    await assert.rejects(client([response(401, {})]).jev.evaluate(body), { message: /key was rejected/ });
    await assert.rejects(client([response(402, {})]).jev.evaluate(body), { message: /budget is used up/ });
  });

  it("passes other gateway errors through in the gateway's words", async () => {
    const reply = response(403, { error: { message: 'Add a credit card to use AI Gateway.' } });
    await assert.rejects(client([reply]).jev.evaluate(body), {
      status: 403,
      message: 'Add a credit card to use AI Gateway.',
    });
  });
});
