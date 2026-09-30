/**
 * Settings page, opened on install: picks the Jev provider and connects its
 * key. A saved key is never put back into the input; it shows as a masked
 * badge with Test, Replace and Remove.
 */

import { DEFAULT_PROVIDER, JevError, PROVIDERS, createJevClient, maskKey } from '../lib/jev.js';

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

/** Status icons per tone. Trusted constants. */
const ICONS = {
  progress:
    '<svg width="18" height="18" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-opacity="0.3" stroke-width="1.5"/><g class="spin"><path d="M6 1.4 A4.6 4.6 0 0 1 10.6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></g></svg>',
  error:
    '<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="var(--sr-err-mark)"/><path d="M8 4.2v4.6" stroke="var(--sr-err-bg)" stroke-width="2" stroke-linecap="round"/><circle cx="8" cy="11.6" r="1.1" fill="var(--sr-err-bg)"/></svg>',
  ok: '<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" fill="var(--sr-ok-mark)"/><path d="M4.8 8.2l2.1 2.1 4.3-4.5" fill="none" stroke="var(--sr-ok-bg)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  info: '<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5.2 8h5.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

const form = document.getElementById('key-form');
const input = document.getElementById('api-key');
const cancel = document.getElementById('cancel');
const connected = document.getElementById('connected');
const connectedTitle = document.getElementById('connected-title');
const formStatus = document.getElementById('key-status');
const connectedStatus = document.getElementById('connected-status');
const radios = [...form.elements.provider];

let { apiKey = '', provider = DEFAULT_PROVIDER } = await chrome.storage.local.get(['apiKey', 'provider']);
if (!PROVIDERS[provider]) provider = DEFAULT_PROVIDER;
render();

const selected = () => radios.find((radio) => radio.checked)?.value ?? provider;

/** Steps, placeholder and privacy line follow the provider being shown. */
function showProvider(id) {
  document.getElementById('steps').innerHTML = STEPS[id].map((step) => `<li><span>${step}</span></li>`).join('');
  input.placeholder = PROVIDERS[id].placeholder;
  document.getElementById('host').textContent = PROVIDERS[id].host;
}

function render(editing = false) {
  const showForm = editing || !apiKey;
  form.hidden = !showForm;
  connected.hidden = showForm;
  cancel.hidden = !apiKey;
  input.value = '';
  const replacing = showForm && Boolean(apiKey);
  document.getElementById('form-title').textContent = replacing ? 'Replace your key' : 'Connect Jev';
  const current = document.getElementById('current');
  current.hidden = !replacing;
  current.textContent = `Currently connected via ${PROVIDERS[provider].label} · ${maskKey(apiKey)}`;
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

/**
 * Checks the key with one throwaway question. Only a proper answer, or a rate
 * limit (the provider checks the key before it counts the request), is a pass.
 *
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function test(id, key) {
  try {
    await createJevClient({ getKey: () => key, getProvider: () => id }).evaluate({
      state: 'ping',
      questions: {
        ok: { type: 'choice', instructions: 'Is this a test message?', criteria: { yes: 'Yes', no: 'No' } },
      },
    });
    return { ok: true, message: 'Key works.' };
  } catch (error) {
    if (error instanceof JevError) {
      if (error.busy) return { ok: true, message: 'Provider is busy; the key format was accepted.' };
      return { ok: false, message: error.message };
    }
    // Anything else is our bug, not the provider's answer: log it so it can be diagnosed.
    console.error(error);
    return { ok: false, message: 'Something went wrong while checking the key. Try again.' };
  }
}

/** @param {'progress' | 'error' | 'ok' | 'info'} [tone] An empty `text` hides the box. */
function setStatus(el, text, tone = 'info') {
  el.dataset.tone = tone;
  el.innerHTML = text ? ICONS[tone] : '';
  if (text) el.append(Object.assign(document.createElement('div'), { textContent: text }));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = selected();
  const key = input.value.trim();
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.textContent = 'Checking…';
  setStatus(formStatus, `Checking key with ${PROVIDERS[id].label}…`, 'progress');
  const { ok, message } = await test(id, key);
  button.disabled = false;
  button.textContent = 'Connect';
  if (!ok) return setStatus(formStatus, message, 'error');
  apiKey = key;
  provider = id;
  await chrome.storage.local.set({ apiKey, provider });
  setStatus(formStatus, '');
  render();
  connectedTitle.focus(); // the form (and the button that had focus) just went away
  setStatus(connectedStatus, `${message} ${document.body.dataset.next}`, 'ok');
});

document.getElementById('test').addEventListener('click', async () => {
  setStatus(connectedStatus, 'Checking key…', 'progress');
  const { ok, message } = await test(provider, apiKey);
  setStatus(connectedStatus, message, ok ? 'ok' : 'error');
});

document.getElementById('replace').addEventListener('click', () => render(true));
cancel.addEventListener('click', () => {
  render();
  connectedTitle.focus();
});

document.getElementById('remove').addEventListener('click', async () => {
  await chrome.storage.local.remove('apiKey');
  apiKey = '';
  setStatus(formStatus, 'Key removed from this browser.');
  render();
});
