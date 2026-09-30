# Shared files

These files are copied from [jev-shared](https://github.com/dgr8akki/jev-shared) with `node scripts/sync-shared.js`. Do not edit them here: change them upstream, then re-sync. CI runs `node scripts/sync-shared.js --check` and fails when a copy differs from the pinned commit.

- Upstream: https://github.com/dgr8akki/jev-shared
- Commit: `5e55284e85418df780eea0362006554fed0800d4`

| Upstream path             | Local path               | Note                 |
| ------------------------- | ------------------------ | -------------------- |
| `shared/src/lib/jev.js`   | `src/lib/jev.js`         |                      |
| `shared/test/jev.test.js` | `test/jev.test.js`       |                      |
| `shared/test/helpers.js`  | `test/helpers.js`        |                      |
| `scripts/sync-shared.js`  | `scripts/sync-shared.js` | keeps itself in sync |
