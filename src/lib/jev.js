/**
 * Minimal client for Jev, TypeSafe's System One decision model, called either
 * directly through TypeSafe's API or through Vercel AI Gateway. Both take the
 * same `{ model, state, questions }` body and return `{ answers }`.
 *
 * Jev never generates text: it answers typed questions (choice, score, boolean)
 * with probabilities. Everything the extension acts on is picked from lists
 * that our own code builds.
 *
 * @module lib/jev
 */

/**
 * @typedef {'vercel' | 'typesafe'} ProviderId
 * @typedef {object} Provider
 * @property {string} label
 * @property {string} endpoint
 * @property {string} model
 * @property {string} host Shown to users as where the key and page summaries go.
 * @property {string} keysUrl Where to create a key.
 * @property {string} placeholder
 * @property {string} budgetMessage Shown on HTTP 402.
 * @property {string} yesNoType What the provider calls a yes/no question.
 */

/** @type {Record<ProviderId, Provider>} */
export const PROVIDERS = {
  vercel: {
    label: 'Vercel AI Gateway',
    endpoint: 'https://ai-gateway.vercel.sh/v1/evaluate',
    model: 'typesafe-ai/jev',
    host: 'ai-gateway.vercel.sh',
    keysUrl: 'https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys',
    placeholder: 'vck_…',
    budgetMessage: 'Your AI Gateway budget is used up. Raise it in the Vercel dashboard.',
    yesNoType: 'boolean',
  },
  typesafe: {
    label: 'TypeSafe',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    host: 'api.typesafe.ai',
    keysUrl: 'https://console.typesafe.ai/keys',
    placeholder: 'Your TypeSafe API key',
    budgetMessage: 'Your TypeSafe credit is used up. Top up in the TypeSafe console.',
    yesNoType: 'noul',
  },
};

export const DEFAULT_PROVIDER = 'vercel';

/** `vck_…a1b2`: enough to recognise a key, not to use it. */
export function maskKey(key) {
  return key.length > 12 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '••••';
}

/**
 * Callers write yes/no questions the Vercel way (`boolean`, answered with
 * `probability`); TypeSafe calls them `noul` and answers with `noul`.
 */
function toWire(provider, questions) {
  if (provider.yesNoType === 'boolean') return questions;
  return Object.fromEntries(
    Object.entries(questions).map(([name, q]) => [name, q.type === 'boolean' ? { ...q, type: 'noul' } : q]),
  );
}

function fromWire(answers = {}) {
  return Object.fromEntries(
    Object.entries(answers).map(([name, a]) => [
      name,
      a?.type === 'noul' ? { type: 'boolean', probability: a.noul } : a,
    ]),
  );
}

/** Default pause when the provider rate-limits us without a Retry-After header. */
const DEFAULT_RETRY_AFTER_S = 30;

export class JevError extends Error {
  /**
   * @param {string} message Human-readable, safe to show in the UI.
   * @param {{ status?: number, retryAfter?: number }} [details]
   */
  constructor(message, { status = 0, retryAfter = 0 } = {}) {
    super(message);
    this.name = 'JevError';
    this.status = status;
    this.retryAfter = retryAfter;
  }

  /** True when TypeSafe is overloaded or we are being rate-limited. */
  get busy() {
    return this.status === 429;
  }
}

/**
 * @typedef {object} JevClient
 * @property {(body: { state: unknown, questions: object }) => Promise<Record<string, any>>} evaluate
 *   Runs one evaluation and resolves with the `answers` object.
 * @property {() => number} secondsPaused Seconds left on a rate-limit pause (0 when free).
 */

/**
 * @param {object} options
 * @param {() => string | Promise<string>} options.getKey Returns the API key for the provider.
 * @param {() => ProviderId | Promise<ProviderId>} [options.getProvider] Unknown values fall back to Vercel.
 * @param {typeof fetch} [options.fetchImpl] Injected for tests.
 * @param {() => number} [options.now] Injected for tests.
 * @returns {JevClient}
 */
export function createJevClient({
  getKey,
  getProvider = () => DEFAULT_PROVIDER,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
}) {
  let pausedUntil = 0;

  const secondsPaused = () => Math.max(0, Math.ceil((pausedUntil - now()) / 1000));

  const post = (provider, key, body) =>
    fetchImpl(provider.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: provider.model, ...body, questions: toWire(provider, body.questions) }),
    });

  async function evaluate(body) {
    const wait = secondsPaused();
    if (wait) throw busyError(wait);

    const provider = PROVIDERS[await getProvider()] ?? PROVIDERS[DEFAULT_PROVIDER];
    const key = (await getKey())?.trim();
    if (!key) throw new JevError('Add your API key in settings.', { status: 401 });

    let res = await post(provider, key, body);
    // TypeSafe returns transient 5xx under load; one retry clears most of them.
    if (res.status >= 500) res = await post(provider, key, body);

    const json = await res.json().catch(() => ({}));
    if (res.ok) return fromWire(json.answers);

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || DEFAULT_RETRY_AFTER_S;
      pausedUntil = now() + retryAfter * 1000;
      throw busyError(retryAfter);
    }
    // Vercel rejects keys with 401; TypeSafe with 403 and an authentication_error.
    if (res.status === 401 || json.detail?.error_type === 'authentication_error') {
      throw new JevError('Your API key was rejected. Check it in settings.', { status: 401 });
    }
    if (res.status === 402) throw new JevError(provider.budgetMessage, { status: 402 });
    const message =
      json.error?.message ?? json.detail?.message ?? json.message ?? `Jev request failed (HTTP ${res.status}).`;
    throw new JevError(message, { status: res.status });
  }

  return { evaluate, secondsPaused };
}

function busyError(seconds) {
  return new JevError(`Jev is busy. Try again in ${seconds}s.`, { status: 429, retryAfter: seconds });
}
