/** Popup: saves the API key and checks it with one tiny Jev call. */

import { createJevClient } from '../lib/jev.js';

const input = document.getElementById('api-key');
const status = document.getElementById('key-status');

const { apiKey = '' } = await chrome.storage.local.get('apiKey');
input.value = apiKey;
if (!apiKey) input.focus();

document.getElementById('key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = input.value.trim();
  await chrome.storage.local.set({ apiKey: key });
  setStatus('Checking key…');
  try {
    const jev = createJevClient({ getKey: () => key });
    await jev.evaluate({
      state: 'ping',
      questions: { ok: { type: 'boolean', instructions: 'Is this a test message?' } },
    });
    setStatus('Key saved and working. Reload LinkedIn to start.', 'ok');
  } catch (error) {
    setStatus(error.message, 'error');
  }
});

function setStatus(text, tone) {
  status.textContent = text;
  status.className = tone ? `hint status-${tone}` : 'hint';
}
