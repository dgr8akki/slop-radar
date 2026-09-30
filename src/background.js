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

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type !== 'rate' || typeof message.text !== 'string') return false;
  rater.rate(message.text).then(
    (rating) => reply({ rating }),
    (error) => reply({ error: error instanceof JevError ? error.message : 'Rating failed. Reload to try again.' }),
  );
  return true; // reply asynchronously
});
