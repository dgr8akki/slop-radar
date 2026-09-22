// Renders assets/icon.svg to the PNG sizes Chrome needs, using headless Chrome.
// Usage: npm run icons   (set CHROME_PATH if Chrome isn't in the default location)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SIZES = [16, 32, 48, 128];
const chrome =
  process.env.CHROME_PATH ??
  {
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: 'google-chrome',
    win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  }[process.platform];

const root = new URL('../', import.meta.url);
const svg = readFileSync(new URL('assets/icon.svg', root), 'utf8');
const work = mkdtempSync(join(tmpdir(), 'icons-'));

try {
  for (const size of SIZES) {
    const page = join(work, `icon-${size}.html`);
    writeFileSync(
      page,
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    const target = new URL(`src/icons/icon-${size}.png`, root).pathname;
    execFileSync(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--window-size=${size},${size}`,
        `--screenshot=${target}`,
        `file://${page}`,
      ],
      { stdio: 'ignore' },
    );
    console.log(`Rendered ${target}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
