import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { JevError, PROVIDERS, createJevClient, maskKey } from '../src/lib/jev.js';
import { response } from './helpers.js';

const body = { state: 'ping', questions: { ok: { type: 'boolean', instructions: 'Test?' } } };

/** Client whose fetch replies with `replies` in order and records requests. */
function client(replies, { key = 'vck_test', provider, now = () => 0 } = {}) {
  const requests = [];
  const jev = createJevClient({
    getKey: () => key,
    getProvider: () => provider,
    now,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return replies.shift();
    },
  });
  return { jev, requests };
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
    const { jev, requests } = client([response(200, { answers: {} })], { key: 'ts_test', provider: 'typesafe' });
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

  it('retries a server error once', async () => {
    const { jev, requests } = client([response(503, {}), response(200, { answers: { ok: {} } })]);
    assert.deepEqual(await jev.evaluate(body), { ok: {} });
    assert.equal(requests.length, 2);
  });

  it('surfaces a second server error', async () => {
    const { jev } = client([response(503, {}), response(503, { error: { message: 'Service unavailable' } })]);
    await assert.rejects(jev.evaluate(body), { status: 503, message: 'Service unavailable' });
  });

  it('pauses after a rate limit and refuses calls until Retry-After passes', async () => {
    let now = 0;
    const { jev, requests } = client([response(429, {}, { 'retry-after': '20' }), response(200, { answers: {} })], {
      now: () => now,
    });

    const error = await jev.evaluate(body).catch((e) => e);
    assert.ok(error instanceof JevError && error.busy);
    assert.equal(error.retryAfter, 20);
    assert.equal(jev.secondsPaused(), 20);

    now = 5_000;
    await assert.rejects(jev.evaluate(body), { status: 429, message: /15s/ });
    assert.equal(requests.length, 1, 'no request while paused');

    now = 20_000;
    assert.deepEqual(await jev.evaluate(body), {});
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
