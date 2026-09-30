# Shared files

These files are copied from [jev-shared](https://github.com/dgr8akki/jev-shared) with `node scripts/sync-shared.js`. Do not edit them here: change them upstream, then re-sync. CI runs `node scripts/sync-shared.js --check` and fails when a copy differs from the pinned commit.

- Upstream: https://github.com/dgr8akki/jev-shared
- Commit: `ed2a37ab2de60e53f603354a39088f158f20f1f6`

| Upstream path                    | Local path                | Note                                                                  |
| -------------------------------- | ------------------------- | --------------------------------------------------------------------- |
| `shared/src/lib/jev.js`          | `src/lib/jev.js`          | worker passes `pauseStore: sessionPauseStore(chrome.storage.session)` |
| `shared/src/lib/connection.js`   | `src/lib/connection.js`   | mounted with the default `btn-primary` / `btn-secondary` classes      |
| `shared/src/options/options.js`  | `src/options/options.js`  | page contract: see jev-shared SHARED.md                               |
| `shared/test/jev.test.js`        | `test/jev.test.js`        |                                                                       |
| `shared/test/manifest-shared.js` | `test/manifest-shared.js` | registered from `test/manifest.test.js`                               |
| `shared/test/helpers.js`         | `test/helpers.js`         |                                                                       |
| `shared/scripts/render-icons.js` | `scripts/render-icons.js` | `npm run icons`; this repo's version was the source                   |
| `scripts/sync-shared.js`         | `scripts/sync-shared.js`  | keeps itself in sync                                                  |
