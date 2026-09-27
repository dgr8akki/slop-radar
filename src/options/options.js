/**
 * Settings page, opened on install: picks the Jev provider and connects its
 * key. A saved key is never put back into the input; it shows as a masked
 * badge with Test, Replace and Remove.
 */

import { DEFAULT_PROVIDER, PROVIDERS, createJevClient, maskKey } from '../lib/jev.js';

/** Setup steps per provider. Trusted constants, so innerHTML is fine. */
const link = (href, text) => `<a href="${href}" target="_blank" rel="noreferrer">${text}</a>`;
const STEPS = {
  vercel: [
    `${link(PROVIDERS.vercel.keysUrl, 'Create an AI Gateway API key')} in the Vercel dashboard.`,
    `Set a ${link('https://vercel.com/docs/ai-gateway/observability-and-spend/budgets', 'spend limit')} on it (optional, recommended).`,
    'Paste it here.',
  ],
  typesafe: [`${link(PROVIDERS.typesafe.keysUrl, 'Create an API key')} in the TypeSafe console.`, 'Paste it here.'],
};

const form = document.getElementById('key-form');
const input = document.getElementById('api-key');
const cancel = document.getElementById('cancel');
const connected = document.getElementById('connected');
const formStatus = document.getElementById('key-status');
const connectedStatus = document.getElementById('connected-status');
const radios = [...form.elements.provider];

let { apiKey = '', provider = DEFAULT_PROVIDER } = await chrome.storage.local.get(['apiKey', 'provider']);
if (!PROVIDERS[provider]) provider = DEFAULT_PROVIDER;
render();

const selected = () => radios.find((radio) => radio.checked)?.value ?? provider;

/** Steps, placeholder and privacy line follow the provider being shown. */
function showProvider(id) {
  document.getElementById('steps').innerHTML = STEPS[id].map((step) => `<li>${step}</li>`).join('');
  input.placeholder = PROVIDERS[id].placeholder;
  document.getElementById('host').textContent = PROVIDERS[id].host;
}

function render(editing = false) {
  const showForm = editing || !apiKey;
  form.hidden = !showForm;
  connected.hidden = showForm;
  cancel.hidden = !apiKey;
  input.value = '';
  radios.forEach((radio) => (radio.checked = radio.value === provider));
  showProvider(provider);
  document.getElementById('provider-label').textContent = PROVIDERS[provider].label;
  document.getElementById('masked').textContent = maskKey(apiKey);
  if (showForm) input.focus();
}

radios.forEach((radio) =>
  radio.addEventListener('change', () => {
    showProvider(selected());
    setStatus(formStatus, '');
    input.focus();
  }),
);

/** Resolves with an error message, or '' when the key works. */
async function test(id, key) {
  try {
    await createJevClient({ getKey: () => key, getProvider: () => id }).evaluate({
      state: 'ping',
      questions: {
        ok: { type: 'choice', instructions: 'Is this a test message?', criteria: { yes: 'Yes', no: 'No' } },
      },
    });
    return '';
  } catch (error) {
    // A busy provider still accepted the key.
    return error.busy ? '' : error.message;
  }
}

function setStatus(el, text, tone) {
  el.textContent = text;
  el.className = tone ? `status-${tone}` : 'muted';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = selected();
  const key = input.value.trim();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  setStatus(formStatus, `Checking key with ${PROVIDERS[id].label}…`);
  const error = await test(id, key);
  button.disabled = false;
  if (error) return setStatus(formStatus, error, 'error');
  apiKey = key;
  provider = id;
  await chrome.storage.local.set({ apiKey, provider });
  setStatus(formStatus, '');
  render();
  setStatus(connectedStatus, `Key works. ${document.body.dataset.next}`, 'ok');
});

document.getElementById('test').addEventListener('click', async () => {
  setStatus(connectedStatus, 'Checking key…');
  const error = await test(provider, apiKey);
  setStatus(connectedStatus, error || 'Key works.', error ? 'error' : 'ok');
});

document.getElementById('replace').addEventListener('click', () => render(true));
cancel.addEventListener('click', () => render());

document.getElementById('remove').addEventListener('click', async () => {
  await chrome.storage.local.remove('apiKey');
  apiKey = '';
  setStatus(formStatus, 'Key removed from this browser.');
  render();
});
