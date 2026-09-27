/** Popup: the label legend, plus the Jev connection. The key is set on the settings page. */

import { mountConnection } from '../lib/connection.js';

await mountConnection(document.getElementById('connection'), document.getElementById('open-settings'));
