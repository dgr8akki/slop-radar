/**
 * Service worker: rates post text sent by the LinkedIn content script. The API
 * key and the rating cache live in extension storage, out of the page's reach.
 */

import { JevError, createJevClient, sessionPauseStore } from './lib/jev.js';
import { createCache, createRater } from './lib/rating.js';

// Keeps storage.local away from the content script. Needs Chrome 140+: older builds throw here,
// and an uncaught throw would stop the listeners below from ever registering.
try {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
} catch {
  // The page could read storage.local on this Chrome, but the worker must keep running.
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

const jev = createJevClient({
  getKey: async () => (await chrome.storage.local.get('apiKey')).apiKey ?? '',
  getProvider: async () => (await chrome.storage.local.get('provider')).provider,
  // Chrome kills a quiet worker after ~30 s, and a 429 pause held in memory would die with it.
  // Session storage survives that and still empties when the browser closes.
  pauseStore: sessionPauseStore(chrome.storage.session),
});
const rater = createRater({ jev, cache: createCache(chrome.storage.local) });

/** Which card the page shows for a 401: no key yet, or one the provider refused. */
async function authCode() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  return apiKey ? 'bad-key' : 'no-key';
}

/** What the page is told when a rating fails. */
async function describeFailure(error) {
  // A rate limit is flow control, not a failure: the page waits retryAfter seconds and asks again.
  if (error.busy) return { error: error.message, retryAfter: error.retryAfter };
  if (error.status === 401) return { error: error.message, code: await authCode() };
  console.error(error);
  return {
    error:
      error instanceof JevError ? error.message : "Couldn't rate this one. It'll retry when it scrolls back into view.",
  };
}

// Posts queued from tabs, keyed by tab, document and the page's own id, so a cancel from the page drops
// the right one and a document that goes away (reload, navigation, closed tab) takes its queue with it:
// its results must not land on the next page's posts, nor cost requests nobody will see.
const queued = new Map();
const scope = (sender) => `${sender.tab?.id}:${sender.documentId}`;
function dropQueued(match) {
  for (const entry of queued.values()) if (match(entry)) entry.controller.abort();
}
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') dropQueued((entry) => entry.tab === tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => dropQueued((entry) => entry.tab === tabId));

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === 'open-options') {
    // Content scripts can't open the settings page themselves.
    chrome.runtime.openOptionsPage();
    reply({});
    return false;
  }
  if (message?.type === 'cancel') {
    queued.get(`${scope(sender)}:${message.id}`)?.controller.abort();
    return false;
  }
  if (message?.type === 'cancel-all') {
    dropQueued((entry) => entry.scope === scope(sender));
    return false;
  }
  if (message?.type !== 'rate' || typeof message.text !== 'string') return false;

  const tab = sender.tab?.id;
  if (tab === undefined) {
    // Not from a tab (an extension page): answer on the same message.
    rater.rate(message.text).then(
      (rating) => reply({ rating }),
      async (error) => reply(await describeFailure(error)),
    );
    return true;
  }

  // From the feed: acknowledge now, then report back to that document as the post's turn comes and goes,
  // so the page can time the request itself rather than the queue in front of it.
  const controller = new AbortController();
  const key = `${scope(sender)}:${message.id}`;
  queued.set(key, { controller, tab, scope: scope(sender) });
  const target = sender.documentId ? { documentId: sender.documentId } : {};
  const tell = (body) => chrome.tabs.sendMessage(tab, { id: message.id, ...body }, target).catch(() => {});
  rater
    .rate(message.text, { signal: controller.signal, onStart: () => tell({ type: 'started' }) })
    .then(
      (rating) => tell({ type: 'rated', rating }),
      async (error) => {
        if (error.name !== 'AbortError') tell({ type: 'rated', ...(await describeFailure(error)) });
      },
    )
    .finally(() => queued.delete(key));
  reply({ queued: true });
  return false;
});

// A key saved or removed in settings: forget any remembered rejection and tell open LinkedIn tabs, which
// can't read storage themselves. Without the tabs permission a url filter on tabs.query matches nothing
// (content-script matches don't make tab URLs visible), so every tab gets the message and the ones
// without our script reject it.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !(changes.apiKey || changes.provider)) return;
  rater.reset();
  const connected = Boolean((await chrome.storage.local.get('apiKey')).apiKey);
  for (const tab of await chrome.tabs.query({})) {
    chrome.tabs.sendMessage(tab.id, { type: 'status', connected }).catch(() => {});
  }
});
