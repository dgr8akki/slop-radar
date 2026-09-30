/**
 * Minimal client for Jev, TypeSafe's System One decision model, called either
 * directly through TypeSafe's API or through Vercel AI Gateway. Both take the
 * same `{ model, state, questions }` body and return `{ answers }`.
 *
 * Jev never generates text: it answers typed questions (choice, score, boolean)
 * with probabilities. Everything the extension acts on is picked from lists
 * that our own code builds.
 *
 * A 429 pauses the client until Retry-After. By default that pause lives in
 * memory, which a service-worker restart forgets; pass `pauseStore` (see
 * `sessionPauseStore`) to keep it in `chrome.storage.session` instead, so the
 * next command after a restart still waits out the backoff.
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

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function fromWire(answers) {
  return Object.fromEntries(
    Object.entries(answers).map(([name, a]) => [
      name,
      a?.type === 'noul' ? { type: 'boolean', probability: a.noul } : a,
    ]),
  );
}

/** Default pause when the provider rate-limits us without a Retry-After header. */
const DEFAULT_RETRY_AFTER_S = 30;

/** Jev answers in well under a second; a provider that takes this long is stuck, and a hung request would block every later one. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Pause before the single retry of a 5xx, so a provider mid-hiccup gets a moment rather than the same request again. */
const RETRY_DELAY_MS = 400;

export class JevError extends Error {
  /**
   * @param {string} message Human-readable, safe to show in the UI.
   * @param {{ status?: number, retryAfter?: number, cause?: unknown }} [details]
   *   `status` is the HTTP status, or 0 when no response arrived.
   */
  constructor(message, { status = 0, retryAfter = 0, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
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
 * @typedef {object} PauseStore Where the rate-limit pause (a `Date.now()` value) is kept.
 * @property {() => Promise<number | undefined>} get
 * @property {(until: number) => Promise<void>} set
 */

/** @returns {PauseStore} The default: module memory, lost when the worker restarts. */
function memoryPauseStore() {
  let until = 0;
  return {
    get: async () => until,
    set: async (value) => {
      until = value;
    },
  };
}

/**
 * A pause store over a `chrome.storage` area, meant for `chrome.storage.session`
 * so the pause survives a service-worker restart but not a browser restart:
 *
 *   createJevClient({ …, pauseStore: sessionPauseStore(chrome.storage.session) })
 *
 * @param {{ get(key: string): Promise<Record<string, any>>, set(items: Record<string, any>): Promise<void> }} area
 * @param {string} [key]
 * @returns {PauseStore}
 */
export function sessionPauseStore(area, key = 'jev:pausedUntil') {
  return {
    get: async () => (await area.get(key))[key],
    set: (until) => area.set({ [key]: until }),
  };
}

/**
 * @typedef {object} JevClient
 * @property {(body: { state: unknown, questions: object }) => Promise<Record<string, any>>} evaluate
 *   Runs one evaluation and resolves with the `answers` object.
 */

/**
 * @param {object} options
 * @param {() => string | Promise<string>} options.getKey Returns the API key for the provider.
 * @param {() => ProviderId | Promise<ProviderId>} [options.getProvider] Unknown values fall back to Vercel.
 * @param {typeof fetch} [options.fetchImpl] Injected for tests.
 * @param {() => number} [options.now] Injected for tests.
 * @param {number} [options.timeoutMs] How long one request may take before it fails. Injected for tests.
 * @param {(ms: number) => Promise<void>} [options.sleep] Injected for tests.
 * @param {PauseStore} [options.pauseStore] Where the 429 pause is kept; defaults to module memory.
 * @returns {JevClient}
 */
export function createJevClient({
  getKey,
  getProvider = () => DEFAULT_PROVIDER,
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pauseStore = memoryPauseStore(),
}) {
  // A store that fails must never hide the provider's answer: read as "no pause", write and move on.
  const pausedUntil = () =>
    Promise.resolve()
      .then(() => pauseStore.get())
      .then(
        (until) => until ?? 0,
        () => 0,
      );
  const pauseUntil = (until) =>
    Promise.resolve()
      .then(() => pauseStore.set(until))
      .catch(() => {});

  const secondsPaused = async () => Math.max(0, Math.ceil(((await pausedUntil()) - now()) / 1000));

  async function post(provider, key, body) {
    try {
      return await fetchImpl(provider.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: provider.model, ...body, questions: toWire(provider, body.questions) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        throw new JevError(`${provider.host} took too long to answer. Try again.`, { status: 0, cause: error });
      }
      // Offline, DNS failure, blocked host: fetch rejects with a TypeError the UI can't show as is.
      throw new JevError(`Can't reach ${provider.host}. Check your connection and try again.`, {
        status: 0,
        cause: error,
      });
    }
  }

  async function evaluate(body) {
    const wait = await secondsPaused();
    if (wait) throw busyError(wait);

    const provider = PROVIDERS[await getProvider()] ?? PROVIDERS[DEFAULT_PROVIDER];
    const key = (await getKey())?.trim();
    if (!key) throw new JevError('Add your API key in settings.', { status: 401 });

    let res = await post(provider, key, body);
    // TypeSafe returns transient 5xx under load; one retry after a short pause clears most of them.
    if (res.status >= 500) {
      await sleep(RETRY_DELAY_MS);
      res = await post(provider, key, body);
    }

    const json = await res.json().then(
      (value) => (isRecord(value) ? value : {}),
      () => ({}),
    );
    if (res.ok) {
      // A proxy, captive portal or changed API can answer 200 with anything. Only a reply that
      // answers every question counts; accepting {} once made the options pages save a dead key as working.
      const answers = isRecord(json.answers) ? fromWire(json.answers) : null;
      if (!answers || Object.keys(body.questions).some((name) => !isRecord(answers[name]))) {
        throw new JevError(`Unexpected reply from ${provider.host}.`, { status: res.status });
      }
      return answers;
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || DEFAULT_RETRY_AFTER_S;
      await pauseUntil(now() + retryAfter * 1000);
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

  return { evaluate };
}

function busyError(seconds) {
  return new JevError(`Jev is busy. Try again in ${seconds}s.`, { status: 429, retryAfter: seconds });
}
