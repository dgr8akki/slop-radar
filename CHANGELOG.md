# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Slop Radar now requires Chrome 140 or newer, so the API key and rating cache stay out of the LinkedIn page's reach.
- With no key, or one the provider rejects, the feed shows a single card with a Connect button instead of a "Not rated" tag on every post. Saving a key in settings picks rating up again in open LinkedIn tabs, including posts that were left unrated.

### Fixed

- The Connect button in settings and the popup now meets WCAG AA contrast in the light theme (5.7:1, was 3:1), on hover and when pressed too.
- After Connect or Cancel in settings, keyboard focus moves to the connection card instead of being dropped on the page.
- The settings page no longer saves a key as "Key works." when the provider answers with something that isn't a Jev reply, and says when the provider was busy rather than claiming the key was checked. Being offline now reads "Can't reach <host>" instead of "Failed to fetch".
- A provider reply in an unexpected shape, or no connection, now shows a specific message on the tag rather than "Reload to try again", and rating failures are logged in the service worker.
- Long provider pauses are waited out on the page instead of inside the service worker, which Chrome stops after 30 seconds; tags no longer end up as "Not rated" or ask for a reload when the worker was simply asleep.

## [1.2.0] - 2026-09-28

### Changed

- New look throughout. On LinkedIn, labels are small cream tags with a distinct icon per state so you don't need the colour. Only Human and AI slop mark the card, with a thin inset rule instead of a full outline. Tags step deeper on LinkedIn's dark theme, detected from the card itself.
- Hover or focus a tag for a popover instead of a browser tooltip: one meter showing both sides, signals grouped into "Pointing to slop" and "Pointing to human", and a reminder that it judges writing style, not who wrote it. Escape closes it.
- Popup and settings page redesigned with a warm cream and terracotta theme and bundled fonts (Figtree and Caprasimo, both OFL). Settings adds a style-not-authorship note, provider cards, numbered setup steps and clearer status messages.
- New icon.
- Cached ratings are refreshed once, since the human signal's wording changed.

## [1.1.0] - 2026-09-27

### Added

- Choose your Jev provider on a new settings page: TypeSafe directly (key from the TypeSafe console) or Vercel AI Gateway. Setup steps, key link and privacy line follow the choice.
- The settings page opens on install. A saved key is never shown again: it appears masked with Test, Replace and Remove.
- `npm run eval` uses `TYPESAFE_API_KEY` when set, otherwise `AI_GATEWAY_API_KEY`.

### Changed

- The popup no longer has a key field; it shows "Connected via …" with **Change**, or **Connect Jev** until a key is saved.
- New host permission for `api.typesafe.ai`. Existing installs keep using Vercel until you switch.

## [1.0.0] - 2026-09-25

### Added

- Labels on LinkedIn feed posts as they scroll into view: Human, Unclear or AI slop.
- Hover and keyboard-focus details: slop and human percentages plus the signals behind the verdict (generic hook, broetry or emoji bullets, stock AI phrasing, engagement bait, concrete first-hand details).
- Verdicts from the summed sides of a five-level scale, with "Unclear" when neither side reaches 60%.
- One rating per post, cached (most recent 2,000), and re-rated when "… more" reveals substantially more text.
- One request at a time, waiting out rate limits instead of failing.
- Popup with a label legend and an API key check on save.

[Unreleased]: https://github.com/dgr8akki/slop-radar/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/dgr8akki/slop-radar/releases/tag/v1.2.0
[1.1.0]: https://github.com/dgr8akki/slop-radar/releases/tag/v1.1.0
[1.0.0]: https://github.com/dgr8akki/slop-radar/releases/tag/v1.0.0
