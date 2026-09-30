# Chrome Web Store listing

Paste-ready values for the Developer Dashboard, kept next to the code they describe. Character limits follow each field. Update this file in the same commit as any user-facing change it quotes.

## Store listing

### Title (limit 45)

```text
Slop Radar: AI writing labels
```

(29 chars; from `name` in `src/manifest.json`, so the dashboard cannot change it. No "LinkedIn": third-party names in titles are the usual trademark takedown.)

### Summary (limit 132)

```text
Tags LinkedIn posts Human, Unclear or Reads like AI as you scroll, with the reasons on hover. Judges style, not who wrote it.
```

(125 chars; `description` in `src/manifest.json`, also uneditable in the dashboard.)

### Detailed description (limit 16,000; plain text)

```text
See which posts in your feed are AI slop before you read them.

Slop Radar is an AI writing detector for your LinkedIn feed. As each post scrolls into view it gets a small cream tag: Human, Unclear, or Reads like AI. Hover or tap the tag for a popover with one meter (human on the left, slop on the right), both percentages, and the signals behind the call.

What it looks for
Pointing to slop: a generic hook, one-sentence-per-line "broetry" or emoji bullets, stock phrasing like "let that sink in", engagement bait like "Agree?".
Pointing to human: concrete first-hand detail a template could not produce, such as named people or exact technical detail.
A post is only tagged Human or Reads like AI when one side holds at least 60% of the probability. Anything in between is Unclear, and the popover says so. Posts are rated once they are mostly on screen, one request each, cached so scrolling back is free. The tags follow the site's dark theme, and a post is rated again when "...more" reveals more text.

It judges style, not authorship
No tool can prove a post was written by AI. A person writing in the platform's house style will be tagged too. Read the tags as a hint, never as a verdict on anyone.

Privacy
No servers, no accounts, no analytics. The only thing that leaves your browser is the visible text of feed posts, sent with your own API key to the provider you picked (TypeSafe directly, or Vercel AI Gateway, which forwards to TypeSafe). The author's name, profile, comments, messages and anything about your own account are never sent. Ratings are cached in this browser. It runs on www.linkedin.com and nowhere else. Full policy: github.com/dgr8akki/slop-radar/blob/main/PRIVACY.md

Before you start
You need Chrome 140 or newer and your own API key: a TypeSafe key (console.typesafe.ai/keys) or a Vercel AI Gateway key (vercel.com/docs/ai-gateway). The settings page opens on install: pick the provider, paste the key, press Connect. It is checked before it is saved and never shown again. An evening of scrolling costs less than a cent, billed to your own account.

Limits
The site obfuscates its markup, so Slop Radar relies on two stable hooks. If they change, tags stop appearing until an update, which ships within days. The questions are written in English; other languages are rated less reliably.

Not affiliated with or endorsed by LinkedIn.
Bugs and ideas: github.com/dgr8akki/slop-radar/issues
Open source, MIT licence: github.com/dgr8akki/slop-radar
```

(2483 chars. "LinkedIn" appears 2 times plus the linkedin.com URL, "AI slop" once in the hook, "AI writing detector" once. Keep the "It judges style, not authorship" paragraph whatever else is cut: it answers the one-star "it flagged my human post" review before it is written.)

### Category and language

- Category: Social Media & Communication (second choice: Tools)
- Language: English (United Kingdom); the copy uses British spelling
- Listing locales: en-US, en-GB, en-IN, en-AU, en-CA, all with the same text. The manifest reads its name and summary from `src/_locales/en` and `en_GB`. No other languages until the rater is checked on non-English posts: the questions are written in English and other languages rate less reliably, so a translated listing would invite bad ratings.

### URLs

- Official URL: leave empty (a repo cannot be verified in Search Console)
- Homepage URL: https://github.com/dgr8akki/slop-radar/blob/main/README.md
- Support URL: https://github.com/dgr8akki/slop-radar/issues
- Privacy policy URL: https://github.com/dgr8akki/slop-radar/blob/main/PRIVACY.md

These are GitHub blob URLs on purpose; switch to the Pages site once it exists.

### Screenshots and promo images

Five shots at 1280x800 (or 640x400), a 440x280 tile and a 1400x560 marquee, with captions that keep "LinkedIn" out. They live in `../screenshots/slop-radar/store/` and must be retaken against the build being uploaded: the tag wording, button colours, focus rings and the popup connection line have all changed since they were shot. Not done in this repo.

## Distribution

- Visibility: Unlisted for the first upload, Public after a store install has been checked by hand
- Regions: all
- Pricing: free
- Mature content: no
- Publisher display name: Aakash Pahuja
- Contact email: pahujaaakash5@gmail.com
- Trader declaration: non-trader

## Release notes for the next version (limit 300, for the GitHub release)

```text
Tags now read "Reads like AI" instead of "AI slop"; one connect card replaces per-post "Not rated" tags when no key works; the key check refuses garbled replies; the worker no longer sleeps through rate limits; contrast and focus fixes on every page; needs Chrome 140.
```

(268 chars)

## Privacy practices

Everything below was checked against the code in this commit. Citations name the symbol rather than a line, because lines move.

### Single purpose

```text
Slop Radar tags posts in the user's LinkedIn feed (www.linkedin.com) as Human, Unclear or Reads like AI according to how much their writing style resembles generic AI-generated text, and explains each tag in a popover. It does nothing on any other site.
```

### Permission justifications

`storage` (the `setAccessLevel` try block at the top of `src/background.js`; `createCache` in `src/lib/rating.js`; `sessionPauseStore` passed to `createJevClient` in `src/background.js`)

```text
Keeps the user's API key and chosen provider (TypeSafe or Vercel AI Gateway) in chrome.storage.local, plus a cache of ratings, one small entry per post keyed by a hash of its text and trimmed to roughly the most recent 2,000, so a post scrolled past twice is not paid for twice. storage.local is set to TRUSTED_CONTEXTS (the extension requires Chrome 140, where that call works from the service worker), so the content script on linkedin.com cannot read the key. chrome.storage.session holds only the end time of a rate-limit pause. No post text, author data or browsing data is stored.
```

`host_permissions: https://api.typesafe.ai/*` (`PROVIDERS.typesafe` and `post()` in `src/lib/jev.js`)

```text
Lets the service worker POST post text to TypeSafe's Jev API for rating when the user has chosen TypeSafe as their provider. Requests carry the user's own API key in the Authorization header. Used for nothing else, and not used at all while the user's provider is Vercel.
```

`host_permissions: https://ai-gateway.vercel.sh/*` (`PROVIDERS.vercel` and `post()` in `src/lib/jev.js`)

```text
Lets the service worker POST post text to Vercel AI Gateway, which forwards it to the same Jev model, when the user has chosen Vercel as their provider. Same request body, same key handling. Not used while the user's provider is TypeSafe. Both hosts are declared because the user picks between them on the settings page; requesting one at runtime would add a second prompt for no privacy gain.
```

`content_scripts` matching `https://www.linkedin.com/*` (`src/content/content.js`: `FEED_ROUTE`, `check()`, `ask()`, `showCard()`)

```text
The content script runs only on www.linkedin.com. It watches feed posts with an IntersectionObserver and, when a post is 40% on screen, reads the visible text of the post body and sends it to the service worker, then inserts a small tag with the verdict and a popover that opens on hover, focus or tap. It only looks for posts on feed-like routes (the feed, a profile's activity, a company's posts, content search); on messaging, jobs and other pages it does nothing. It matches the whole host rather than /feed/ alone because LinkedIn is a single-page app and a script matched to one path would not be injected when the user reaches the feed by navigating within the site. It does not read author names, profile data, comments, messages or anything about the user's own account, and it makes no network requests itself. Posts under 80 characters are ignored. When no key is saved or the key is rejected, it shows one card at the top of the feed whose button asks the service worker to open the settings page.
```

Web accessible resources: none declared.

Remote code:

```text
No. All code ships in the package. No remote scripts, no eval, no dynamic import from a URL. The only network traffic is POST requests to the chosen model API, which return JSON probabilities. Fonts are bundled under the SIL Open Font License. innerHTML is used only with string constants defined in the extension's own source: the tag glyphs and popover stylesheet in content.js, the setup steps and link mark in the shared options.js, and the status marks in <template> elements in options.html.
```

### Data usage

Tick:

- Website content: the visible text of feed posts is sent to the provider (`check()` in `src/content/content.js`; the `rate` handler in `src/background.js`; `rateNow()` in `src/lib/rating.js`).
- Authentication information: the API key is stored and sent as a bearer token to the provider that issued it (`post()` in `src/lib/jev.js`).

Leave unticked: personally identifiable information (author names are not read; names inside post text are website content), health, financial, personal communications (the script never touches messaging), location, web history (no URLs are sent), user activity (nothing about clicks, scrolls or typing is reported).

Certify all three: no sale or transfer outside the approved use, no use unrelated to the single purpose (there is no analytics or telemetry), no creditworthiness or lending use.

### Pre-upload checks

- `src/manifest.json` and `package.json` carry the same version; `npm run package` refuses otherwise.
- `minimum_chrome_version` is 140 and `setAccessLevel` sits in a try block (`test/manifest.test.js`).
- Permissions are exactly `storage`, the two API hosts and the one content-script host (`test/manifest.test.js`).
- The zip from `npm run package` contains `manifest.json` at its root and the `_locales` folder if one exists.
