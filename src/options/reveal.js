/**
 * Show/hide for the key field, so a pasted key can be read back before it is
 * sent. options.js is shared with the other extensions, so this lives apart.
 */

const input = document.getElementById('api-key');
const button = document.getElementById('reveal');

// The label stays put; aria-pressed carries the state.
function reveal(show) {
  input.type = show ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(show));
}

button.addEventListener('click', () => {
  reveal(input.type === 'password');
  input.focus({ preventScroll: true });
});

// A key that has been checked goes to storage, and a cancelled edit is over: nothing readable stays on screen.
input.form.addEventListener('submit', () => reveal(false));
document.getElementById('cancel').addEventListener('click', () => reveal(false));
