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

// First install: open settings in a tab to pick a provider and connect a key.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

const jev = createJevClient({
  getKey: async () => (await chrome.storage.local.get('apiKey')).apiKey ?? '',
  getProvider: async () => (await chrome.storage.local.get('provider')).provider,
  // A 429 pause kept in memory would be forgotten when Chrome stops the idle worker; session storage
  // outlives that and is cleared with the browser.
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
  return { error: error instanceof JevError ? error.message : 'Rating failed. It will be tried again later.' };
}

// Posts queued from tabs, so a cancel from the page can drop one that scrolled away before its turn.
const queued = new Map();
const queueKey = (sender, id) => `${sender.tab?.id}:${id}`;

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === 'open-options') {
    // Content scripts can't open the settings page themselves.
    chrome.runtime.openOptionsPage();
    reply({});
    return false;
  }
  if (message?.type === 'cancel') {
    queued.get(queueKey(sender, message.id))?.abort();
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

  // From the feed: acknowledge now, then report back over the tab as the post's turn comes and goes, so
  // the page can time the request itself rather than the queue in front of it.
  const controller = new AbortController();
  const key = queueKey(sender, message.id);
  queued.set(key, controller);
  const tell = (body) => chrome.tabs.sendMessage(tab, { id: message.id, ...body }).catch(() => {});
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
