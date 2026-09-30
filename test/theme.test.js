import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const theme = readFileSync(new URL('../src/ui/theme.css', import.meta.url), 'utf8');
const content = readFileSync(new URL('../src/content/content.css', import.meta.url), 'utf8');

/** WCAG 2.x relative luminance of a #rrggbb colour. */
function luminance(hex) {
  const [r, g, b] = hex
    .replace('#', '')
    .match(/../g)
    .map((c) => parseInt(c, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** Custom properties declared in the first rule whose selector matches, as { name: '#hex' }. */
function tokens(css, selector) {
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `no ${selector} in the stylesheet`);
  const block = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2].toLowerCase()]),
  );
}

const AA = 4.5;
const ok = (fg, bg, what) =>
  assert.ok(contrast(fg, bg) >= AA, `${what}: ${fg} on ${bg} is ${contrast(fg, bg).toFixed(2)}:1`);

describe('primary button contrast', () => {
  it('passes AA in the light theme, hovered and pressed too', () => {
    const light = tokens(theme, ':root {');
    ok(light['--btn-fg'], light['--btn-bg'], 'rest');
    ok(light['--btn-fg'], light['--btn-bg-hover'], 'hover');
    ok(light['--btn-fg'], light['--btn-bg-active'], 'active');
  });

  it('passes AA in the dark theme, hovered and pressed too', () => {
    const dark = tokens(theme.slice(theme.indexOf('prefers-color-scheme: dark')), ':root {');
    ok(dark['--btn-fg'], dark['--btn-bg'], 'rest');
    ok(dark['--btn-fg'], dark['--btn-bg-hover'], 'hover');
    ok(dark['--btn-fg'], dark['--btn-bg-active'], 'active');
  });

  it('uses the tokens rather than the accent, whose contrast on cream is 3:1', () => {
    const rule = content.length && theme.slice(theme.indexOf('.btn-primary {'), theme.indexOf('.btn-secondary {'));
    assert.match(rule, /background: var\(--btn-bg\)/);
    assert.match(rule, /color: var\(--btn-fg\)/);
    assert.doesNotMatch(rule, /--color-accent/);
  });

  it('holds for the connect card on LinkedIn, in both feed themes', () => {
    const light = tokens(content, '.slop-radar-card {');
    ok(light['--sr-btn-fg'], light['--sr-btn-bg'], 'card rest');
    ok(light['--sr-btn-fg'], light['--sr-btn-bg-hover'], 'card hover');
    ok(light['--sr-muted'], light['--sr-bg'], 'card aside');
    const dark = tokens(content, ".slop-radar-card[data-slop-radar-theme='dark'] {");
    ok(dark['--sr-btn-fg'], dark['--sr-btn-bg'], 'dark card rest');
    ok(dark['--sr-btn-fg'], dark['--sr-btn-bg-hover'], 'dark card hover');
    ok(dark['--sr-muted'], dark['--sr-bg'], 'dark card aside');
  });
});
