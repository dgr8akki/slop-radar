/**
 * Minimal client for Jev, TypeSafe's System One decision model, called through
 * Vercel AI Gateway's evaluation API.
 *
 * Jev never generates text: it answers typed questions (choice, boolean, score)
 * with probabilities. Everything the extension acts on is picked from lists
 * that our own code builds.
 *
 * @module lib/jev
 */

export const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/evaluate';
export const MODEL = 'typesafe-ai/jev';

/** Default pause when the gateway rate-limits us without a Retry-After header. */
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
 * @param {() => string | Promise<string>} options.getKey Returns the AI Gateway API key.
 * @param {typeof fetch} [options.fetchImpl] Injected for tests.
 * @param {() => number} [options.now] Injected for tests.
 * @returns {JevClient}
 */
export function createJevClient({ getKey, fetchImpl = (...args) => fetch(...args), now = () => Date.now() }) {
  let pausedUntil = 0;

  const secondsPaused = () => Math.max(0, Math.ceil((pausedUntil - now()) / 1000));

  const post = (key, body) =>
    fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, ...body }),
    });

  async function evaluate(body) {
    const wait = secondsPaused();
    if (wait) throw busyError(wait);

    const key = (await getKey())?.trim();
    if (!key) throw new JevError('Add your AI Gateway API key in settings.', { status: 401 });

    let res = await post(key, body);
    // TypeSafe returns transient 5xx under load; one retry clears most of them.
    if (res.status >= 500) res = await post(key, body);

    const json = await res.json().catch(() => ({}));
    if (res.ok) return json.answers;

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || DEFAULT_RETRY_AFTER_S;
      pausedUntil = now() + retryAfter * 1000;
      throw busyError(retryAfter);
    }
    if (res.status === 401) {
      throw new JevError('Your API key was rejected. Check it in settings.', { status: 401 });
    }
    if (res.status === 402) {
      throw new JevError('Your AI Gateway budget is used up. Raise it in the Vercel dashboard.', { status: 402 });
    }
    const message = json.error?.message ?? json.message ?? `Jev request failed (HTTP ${res.status}).`;
    throw new JevError(message, { status: res.status });
  }

  return { evaluate, secondsPaused };
}

function busyError(seconds) {
  return new JevError(`Jev is busy. Try again in ${seconds}s.`, { status: 429, retryAfter: seconds });
}
