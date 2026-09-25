# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-25

### Added

- Labels on LinkedIn feed posts as they scroll into view: Human, Unclear or AI slop.
- Hover and keyboard-focus details: slop and human percentages plus the signals behind the verdict (generic hook, broetry or emoji bullets, stock AI phrasing, engagement bait, concrete first-hand details).
- Verdicts from the summed sides of a five-level scale, with "Unclear" when neither side reaches 60%.
- One rating per post, cached (most recent 2,000), and re-rated when "… more" reveals substantially more text.
- One request at a time, waiting out rate limits instead of failing.
- Popup with a label legend and an API key check on save.

[1.0.0]: https://github.com/dgr8akki/slop-radar/releases/tag/v1.0.0
