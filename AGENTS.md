# AGENTS.md

Guidance for AI coding agents (and humans) working on Slop Radar.

## What this is

A Manifest V3 Chrome extension. A content script on linkedin.com finds feed posts as they scroll into view and labels each one as human, unclear or AI slop. The service worker rates post text with Jev (TypeSafe's System One model, via Vercel AI Gateway's `/v1/evaluate`) and caches the result.

## Commands

```sh
npm install
npm run check      # must pass before every commit: lint + format check + unit tests
npm test           # unit tests only (offline, ~1s)
npm run eval       # live Jev evaluation; needs AI_GATEWAY_API_KEY in .env; waits out 429s
npm run package    # dist/slop-radar-<version>.zip
npm run icons      # re-render src/icons from assets/icon.svg (needs Google Chrome)
```

There is no build step. `src/` is loaded as-is by Chrome.

## Architecture

| Path                      | Responsibility                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/lib/rating.js`       | `QUESTIONS`, `SIGNALS`, `toRating` (verdict rules), `createCache`, `createRater`. Pure and tested. |
| `src/lib/jev.js`          | HTTP client: one 5xx retry, pauses on 429 using `Retry-After`, user-facing errors.                 |
| `src/background.js`       | Wires the rater to `chrome.storage.local` and the message listener. Keep logic out of here.        |
| `src/content/content.js`  | Classic script (content scripts can't be modules). Finds posts, requests ratings, draws labels.    |
| `src/content/content.css` | Label styles. All selectors are prefixed `slop-radar-` to avoid clashing with LinkedIn.            |
| `src/popup/`              | Legend and API key.                                                                                |

Message protocol: the content script sends `{ type: 'rate', text }`; the service worker replies `{ rating }` or `{ error }`.

## Rules

1. **The verdict sums sides of the scale.** Don't switch to Jev's `confidence` (single-level) or the weighted average (pulled to the middle). This was the cause of most posts showing "Unclear" in the prototype.
2. **Only two LinkedIn hooks.** LinkedIn obfuscates class names. The script relies on `[componentkey^="update-card"]` and `[data-testid="expandable-text-box"]` only. If you add a hook, add it to `test/content.test.js`'s fixture.
3. **Passive means patient.** The rater runs one request at a time and waits out rate limits. Never surface a 429 as an alarm on the page.
4. **Send post text only.** Never send author names, profile data, comments or anything about the user. Update `PRIVACY.md` if what is sent changes.
5. **Bump the cache key** (`ratings:v2` in `rating.js`) whenever the `Rating` shape changes, or old entries will render wrongly.
6. **Labels are calm.** Muted colors that pass WCAG AA with white text; no animation; the badge is keyboard-focusable with an `aria-label`.

## Testing

- `test/helpers.js` provides `fakeJev()`, `choice()`, `yesNo()` and `response()`.
- `test/content.test.js` runs the real `content.js` inside a jsdom feed with a fake `IntersectionObserver` and message channel.
- When you change `QUESTIONS` or thresholds, run `npm run eval` and keep it at 100%. Add a sample post for any new behaviour.

## Releasing

1. Bump `version` in both `package.json` and `src/manifest.json` (a test enforces they match).
2. Add an entry to `CHANGELOG.md`.
3. `npm run check && npm run eval && npm run package`, then upload `dist/*.zip` to the Chrome Web Store and attach it to a GitHub release.
