# Changelog

Every Slop Radar release, latest on top, written from where you'd notice the change rather than where it lives in the code. Unreleased is what's on main but not yet in a store build. Versions are semver.

## [1.3.0] - 2026-10-01

### Added

- Settings can show the key while you type it: a Show/Hide button sits beside the field.

### Changed

- The extension name and store summary are read from `_locales`, which has English and British English for now, so the listing can carry English variants.
- Settings and the popup share a single corner radius; the popup's connection tile is now a plain line.
- README rewritten in plain prose: what the tags mean, how it decides, and a troubleshooting table that starts from the connect card.
- The store title is now "Slop Radar: AI writing labels" and the summary says what the tags are and that they judge style, not who wrote it.
- The tag on a post that reads like a template now says "Reads like AI" rather than "AI slop"; the popover title still says "Reads like AI slop". Popover messages say what actually happens: "Checking… usually under a second", and labels resume on their own once rating works again.
- Settings copy rewritten: after connecting it tells you to open the feed and scroll (no reload needed), the provider tiles say whose account they use, and the footer says plainly that the key stays local.
- Slop Radar now requires Chrome 140 or newer, so the API key and rating cache stay out of the LinkedIn page's reach.
- With no key, or one the provider rejects, the feed shows a single card with a Connect button instead of a "Not rated" tag on every post. Saving a key in settings picks rating up again in open LinkedIn tabs, including posts that were left unrated.
- The feed is watched for new posts instead of polled every 1.5 seconds, nothing runs on LinkedIn pages without posts (messaging, jobs, profiles) or in a hidden tab, and rated posts are no longer tracked as they scroll.
- Ratings are cached one entry per post instead of one large object rewritten on every rating, and trimmed in batches. Existing cached ratings are cleared once.
- The popup legend is one short phrase per tag.

### Fixed

- In the popup, the "Reads like AI" tag no longer runs into its description.
- Posts at the top of the feed get tags again. LinkedIn started serving many posts without the `update-card` key Slop Radar looked for, so it skipped them. Any item in the main feed list now counts as a post, and one that matches both is rated once. The tag also moves left of a Follow button and the hide cross as well as the "…" menu, so it stops covering them.
- The tag on each post is now a button: tap or click it to open the popover (hover and focus still work), and it tells assistive tech whether the popover is open instead of taking a tab stop that did nothing.
- The popover's smallest text is now 12px (was 10px), the card widens for long signal names, and the meter's segments are outlined so they don't rely on hue alone.
- Settings: provider tiles, the radio dots, the key field border and its placeholder are drawn in colours that can be seen on the card; the chosen provider is marked in the same deeper terracotta as links.
- Focus rings in settings and the popup are a deeper terracotta that shows clearly on the card (was under 3:1).
- The Connect button in settings and the popup now meets WCAG AA contrast in the light theme (5.7:1, was 3:1), on hover and when pressed too.
- After Connect or Cancel in settings, keyboard focus moves to the connection card instead of landing nowhere.
- Settings: the key field is marked invalid when the provider rejects the key (cleared as you type), stays read-only while a check runs, and links that open a new tab say so.
- The settings page no longer saves a key as "Key works." when the provider answers with something that isn't a Jev reply, and says when the provider was busy rather than claiming the key was checked. Being offline now reads "Can't reach <host>" instead of "Failed to fetch".
- A provider reply in an unexpected shape, or no connection, now shows a specific message on the tag rather than "Reload to try again", and rating failures are logged in the service worker.
- Long provider pauses are waited out on the page instead of inside the service worker, which Chrome stops after 30 seconds; tags no longer end up as "Not rated" or ask for a reload when the worker was simply asleep.
- While the provider is rate limiting, a waiting tag says the provider is busy and when it will ask again.
- A tag whose rating never comes back stops at "Checking" after 30 seconds, says it took too long and asks again when the post scrolls back into view. Scrolling fast past a lot of posts no longer times out the ones still waiting their turn.
- After reloading a LinkedIn tab, ratings meant for the old page no longer land on the new page's posts.
- Removing the key brings up the connect card on the feed straight away. It used to need a reload.
- Clicking a tag while the pointer is over it keeps the popover open instead of closing it.
- Two different posts can no longer end up sharing one cached verdict.
- On a dark system theme the popup no longer flashes light before it draws.

## [1.2.0] - 2026-09-28

### Changed

- New look throughout. On LinkedIn, labels are small cream tags with a distinct icon per state so you don't need the colour. Only Human and AI slop mark the card, with a thin inset rule instead of a full outline. Tags step deeper on LinkedIn's dark theme, detected from the card itself.
- Hover or focus a tag for a popover instead of a browser tooltip: one meter showing both sides, signals grouped into "Pointing to slop" and "Pointing to human", and a reminder that it judges writing style, not who wrote it. Escape closes it.
- Popup and settings page redesigned with a warm cream and terracotta theme and bundled fonts (Figtree and Caprasimo, both OFL). Settings adds a style-not-authorship note, provider cards, numbered setup steps and clearer status messages.
- New icon.
- Cached ratings are refreshed once, since the human signal's wording changed.

## [1.1.0] - 2026-09-27

### Added

- Settings now open on install and ask who should run the model for you: TypeSafe directly, or Vercel AI Gateway. Whichever you pick, the setup steps and the privacy line follow it.
- The key is masked once saved (first four and last four characters) and can be tested, replaced or removed from the same card. It is never shown in full again.
- The live check uses `TYPESAFE_API_KEY` when it is set, otherwise `AI_GATEWAY_API_KEY`.

### Changed

- The popup lost its key field. It says which provider you are connected through and offers Change, or Connect Jev while there is no key.
- A second host permission, for `api.typesafe.ai`. Installs from 1.0.0 keep going through Vercel until you switch.

## [1.0.0] - 2026-09-25

### Added

- Labels on LinkedIn feed posts as they scroll into view: Human, Unclear or AI slop.
- Hover and keyboard-focus details: slop and human percentages plus the signals behind the verdict (generic hook, broetry or emoji bullets, stock AI phrasing, engagement bait, concrete first-hand details).
- Verdicts from the summed sides of a five-level scale, with "Unclear" when neither side reaches 60%.
- One rating per post, cached (most recent 2,000), and re-rated when "… more" reveals substantially more text.
- One request at a time, waiting out rate limits instead of failing.
- Popup with a label legend; saving an API key tests it first.

[1.3.0]: https://github.com/dgr8akki/slop-radar/releases/tag/v1.3.0
[1.2.0]: https://github.com/dgr8akki/slop-radar/releases/tag/v1.2.0
[1.1.0]: https://github.com/dgr8akki/slop-radar/releases/tag/v1.1.0
[1.0.0]: https://github.com/dgr8akki/slop-radar/releases/tag/v1.0.0
