/** Popup: the label legend, plus the Jev connection. The key is set on the settings page. */

import { mountConnection } from '../lib/connection.js';

// The legend reuses the on-page tag styles, which key their dark variant off this attribute.
if (matchMedia('(prefers-color-scheme: dark)').matches) document.body.dataset.slopRadarTheme = 'dark';

const row = document.getElementById('connection-row');
await mountConnection(document.getElementById('connection'), document.getElementById('open-settings'), {
  onChange: (connected) => row.toggleAttribute('data-connected', connected),
});
