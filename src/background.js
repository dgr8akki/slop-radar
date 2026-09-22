/**
 * Service worker: rates post text sent by the LinkedIn content script. The API
 * key and the rating cache live in extension storage, out of the page's reach.
 */

import { JevError, createJevClient } from './lib/jev.js';
import { createCache, createRater } from './lib/rating.js';

chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

const jev = createJevClient({
  getKey: async () => (await chrome.storage.local.get('apiKey')).apiKey ?? '',
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
