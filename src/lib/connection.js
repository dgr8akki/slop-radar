/**
 * The small "Connected via … / Connect Jev" row shown in the popup or side
 * panel. The key itself is entered on the settings page, never here.
 *
 * @module lib/connection
 */

import { DEFAULT_PROVIDER, PROVIDERS, maskKey } from './jev.js';

/** Reads the saved key and provider, as the service worker does for each call. */
export async function getConnection() {
  const { apiKey = '', provider } = await chrome.storage.local.get(['apiKey', 'provider']);
  return { apiKey, provider: PROVIDERS[provider] ? provider : DEFAULT_PROVIDER };
}

/**
 * Fills `text` and `button`, opens settings on click and re-renders when the
 * key changes in another tab.
 *
 * @param {HTMLElement} text
 * @param {HTMLButtonElement} button
 * @param {(connected: boolean) => void} [onChange]
 * @returns {Promise<boolean>} Whether a key is saved.
 */
export async function mountConnection(text, button, onChange = () => {}) {
  async function render() {
    const { apiKey, provider } = await getConnection();
    if (apiKey) {
      const key = Object.assign(document.createElement('span'), { className: 'mono', textContent: maskKey(apiKey) });
      text.replaceChildren(`Connected via ${PROVIDERS[provider].label}`, key);
    } else {
      text.textContent = 'Connect a TypeSafe or Vercel AI Gateway key to start.';
    }
    button.textContent = apiKey ? 'Change' : 'Connect Jev';
    button.classList.toggle('btn-primary', !apiKey);
    button.classList.toggle('btn-secondary', Boolean(apiKey));
    onChange(Boolean(apiKey));
    return Boolean(apiKey);
  }
  button.addEventListener('click', () => chrome.runtime.openOptionsPage());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.apiKey || changes.provider)) render();
  });
  return render();
}
