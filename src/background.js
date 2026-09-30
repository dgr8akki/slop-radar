/**
 * Service worker: rates post text sent by the LinkedIn content script. The API
 * key and the rating cache live in extension storage, out of the page's reach.
 */

import { JevError, createJevClient } from './lib/jev.js';
import { createCache, createRater } from './lib/rating.js';

// Keeps storage.local away from the content script (needs Chrome 140+).
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });

// First install: open settings in a tab to pick a provider and connect a key.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

const jev = createJevClient({
  getKey: async () => (await chrome.storage.local.get('apiKey')).apiKey ?? '',
  getProvider: async () => (await chrome.storage.local.get('provider')).provider,
});
const rater = createRater({ jev, cache: createCache(chrome.storage.local) });

/** Which card the page shows for a 401: no key yet, or one the provider refused. */
async function authCode() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  return apiKey ? 'bad-key' : 'no-key';
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === 'open-options') {
    // Content scripts can't open the settings page themselves.
    chrome.runtime.openOptionsPage();
    reply({});
    return false;
  }
  if (message?.type !== 'rate' || typeof message.text !== 'string') return false;
  rater.rate(message.text).then(
    (rating) => reply({ rating }),
    async (error) => {
      // A rate limit is flow control, not a failure: the page waits retryAfter seconds and asks again.
      if (error.busy) return reply({ error: error.message, retryAfter: error.retryAfter });
      if (error.status === 401) return reply({ error: error.message, code: await authCode() });
      console.error(error);
      reply({ error: error instanceof JevError ? error.message : 'Rating failed. It will be tried again later.' });
    },
  );
  return true; // reply asynchronously
});

// A key saved or removed in settings: forget any remembered rejection and tell open LinkedIn tabs, which
// can't read storage themselves.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !(changes.apiKey || changes.provider)) return;
  rater.reset();
  const connected = Boolean((await chrome.storage.local.get('apiKey')).apiKey);
  for (const tab of await chrome.tabs.query({ url: 'https://www.linkedin.com/*' })) {
    chrome.tabs.sendMessage(tab.id, { type: 'status', connected }).catch(() => {}); // tab without the script yet
  }
});
