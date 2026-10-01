import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// The dashboard rejects over-long fields silently on paste; catch it here instead.
const listing = readFileSync(new URL('../docs/store-listing.md', import.meta.url), 'utf8');
const messages = JSON.parse(readFileSync(new URL('../src/_locales/en/messages.json', import.meta.url), 'utf8'));

/** Every ```text block after `heading`, up to the next heading of the same or higher level. */
function blocks(heading) {
  const start = listing.indexOf(heading);
  assert.notEqual(start, -1, heading);
  const level = heading.match(/^#+/)[0];
  const rest = listing.slice(start + heading.length);
  const next = rest.search(new RegExp(`^#{1,${level.length}} `, 'm'));
  const section = next === -1 ? rest : rest.slice(0, next);
  return [...section.matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => m[1]);
}

describe('store listing limits', () => {
  it('title 45, summary 132', () => {
    assert.ok(messages.name.message.length <= 45);
    assert.ok(messages.description.message.length <= 132);
    assert.equal(blocks('### Summary')[0], messages.description.message, 'listing quotes the manifest summary');
  });

  it('single purpose and every permission justification 1,000 or under', () => {
    const texts = [...blocks('### Single purpose'), ...blocks('### Permission justifications')];
    assert.ok(texts.length >= 5, `${texts.length} justification blocks`);
    for (const text of texts) assert.ok(text.length <= 1000, `${text.length} chars: ${text.slice(0, 40)}`);
  });

  it('detailed description within the target, release notes within 300', () => {
    const [description] = blocks('### Detailed description');
    assert.ok(description.length <= 2500, `${description.length} chars`);
    assert.doesNotMatch(description, /within days|guarantee|100%/i, 'no delivery or accuracy promises');
    const [notes] = blocks('## Release notes');
    assert.ok(notes.length <= 300, `${notes.length} chars`);
  });
});
