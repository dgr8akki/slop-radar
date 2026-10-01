# Chrome Web Store listing

Everything the Developer Dashboard asks for, ready to paste. It sits beside the code so the two change together: if a string quoted here changes, this file changes in that commit. Each field notes its limit.

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

The signals
Pointing to slop: a generic hook, one-sentence-per-line "broetry" or emoji bullets, stock phrasing like "let that sink in", engagement bait like "Agree?".
Pointing to human: concrete first-hand detail a template could not produce, such as named people or exact technical detail.
A post is only tagged Human or Reads like AI when one side holds at least 60% of the probability. Anything in between is Unclear, and the popover says so. Posts are rated once they are mostly on screen, one request each, cached so scrolling back is free. The tags follow the site's dark theme, and a post is rated again when "...more" reveals more text.

It judges style, not authorship
No tool can prove a post was written by AI. A person writing in the platform's house style will be tagged too. Read the tags as a hint, never as a verdict on anyone.

What gets sent
There is no Slop Radar server and nothing reports back to me. What leaves your browser is the visible text of feed posts, sent with your own API key to the provider you picked: TypeSafe, or TypeSafe by way of Vercel AI Gateway. The author's name, profile, comments, messages and anything about your own account are never sent. Ratings are cached in this browser. It runs on www.linkedin.com and nowhere else. Full policy: github.com/dgr8akki/slop-radar/blob/main/PRIVACY.md

You need
Chrome 140 or newer, plus an API key of your own from TypeSafe (console.typesafe.ai/keys) or Vercel AI Gateway (vercel.com/docs/ai-gateway). Settings open when you install. Pick TypeSafe or Vercel, paste, and Connect tries the key once before keeping it, and after that you only see it masked. An evening on the feed costs under a cent, on your account.

Where it fails
The site obfuscates its markup, so Slop Radar relies on two stable hooks. If they change, tags stop appearing until an update. The questions are written in English; other languages are rated less reliably.

Not affiliated with or endorsed by LinkedIn.
Something wrong or missing? github.com/dgr8akki/slop-radar/issues
The code is MIT-licensed: github.com/dgr8akki/slop-radar
```

(2447 chars. "LinkedIn" appears 2 times plus the linkedin.com URL, "AI slop" once in the hook, "AI writing detector" once. Keep the "It judges style, not authorship" paragraph whatever else is cut: it answers the one-star "it flagged my human post" review before it is written.)

### Category and language

- Category: Social Media & Communication (second choice: Tools)
- Language: English (UK), because the copy is spelt the British way
- Listing locales: en-US, en-GB, en-IN, en-AU, en-CA, all with the same text. The manifest reads its name and summary from `src/_locales/en` and `en_GB`. No other languages until the rater is checked on non-English posts: the questions are written in English and other languages rate less reliably, so a translated listing would invite bad ratings.

### URLs

- Official URL: none. Search Console can't verify a GitHub repo, so the field stays blank
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
- Publisher shown on the listing: Aakash Pahuja
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
chrome.storage.local holds the API key with the name of its provider (TypeSafe or Vercel AI Gateway), and a cache of ratings, one small entry per post keyed by a hash of its text and trimmed to roughly the most recent 2,000, so a post scrolled past twice is not paid for twice. storage.local is set to TRUSTED_CONTEXTS (the extension requires Chrome 140, where that call works from the service worker), so the content script on linkedin.com cannot read the key. chrome.storage.session holds only the end time of a rate-limit pause. No post text, author data or browsing data is stored.
```

`host_permissions: https://api.typesafe.ai/*` (`PROVIDERS.typesafe` and `post()` in `src/lib/jev.js`)

```text
If the user picked TypeSafe in settings, the service worker sends post text here for Jev to rate, authorised by the user's own key in the Authorization header. That is the only use. While Vercel is the chosen provider, nothing goes to this host.
```

`host_permissions: https://ai-gateway.vercel.sh/*` (`PROVIDERS.vercel` and `post()` in `src/lib/jev.js`)

```text
The other road to the same Jev model. If the user picked Vercel, post text goes to Vercel AI Gateway instead, with an identical request body and key handling, and the gateway passes it on to Jev. Nothing is sent here while TypeSafe is chosen. I declare both hosts up front because the choice is made on the settings page; asking for one at runtime would mean a second permission prompt and protect nothing.
```

`content_scripts` matching `https://www.linkedin.com/*` (`src/content/content.js`: `FEED_ROUTE`, `check()`, `ask()`, `showCard()`)

```text
The content script runs only on www.linkedin.com. It watches feed posts with an IntersectionObserver and, once about 40% of a post is on screen, reads the visible text of its body, sends it to the service worker, then adds a small tag with the verdict and a popover that opens on hover, focus or tap. It only looks for posts on feed-like routes (the feed, a profile's activity, a company's posts, content search) and does nothing on messaging, jobs or other pages. It matches the whole host rather than /feed/ because LinkedIn is a single-page app: a script tied to one path would not be injected when the user reaches the feed from elsewhere on the site. It does not read author names, profile data, comments, messages or anything about the user's own account, and makes no network requests itself. Posts under 80 characters are ignored. With no key, or a rejected one, it shows one card at the top of the feed whose button asks the service worker to open settings.
```

Web accessible resources: the manifest lists none.

Remote code:

```text
No. Every script Slop Radar runs is in the uploaded zip. None is downloaded afterwards, and there is no eval or import() of a URL. The network is used for one thing, POSTing post text to the chosen model API, and what comes back is JSON with probabilities in it. Fonts are bundled under the SIL Open Font License. innerHTML is used only with string constants defined in the extension's own source: the tag glyphs and popover stylesheet in content.js, the setup steps and link mark in the shared options.js, and the status marks in <template> elements in options.html.
```

### Data usage

Tick:

- Website content: the visible text of feed posts is sent to the provider (`check()` in `src/content/content.js`; the `rate` handler in `src/background.js`; `rateNow()` in `src/lib/rating.js`).
- Authentication information: the API key, kept in storage and sent in each request's Authorization header (Bearer) to the provider that issued it (`post()` in `src/lib/jev.js`).

Leave unticked: personally identifiable information (author names are not read; names inside post text are website content), health, financial, personal communications (the script never touches messaging), location, web history (no URLs are sent), user activity (nothing about clicks, scrolls or typing is reported).

Certify all three. Nothing is sold or handed on, nothing is used outside the single purpose (Slop Radar has no analytics or telemetry), and nothing feeds a credit or lending decision.

### Pre-upload checks

- `src/manifest.json` and `package.json` carry the same version; `npm run package` refuses otherwise.
- `minimum_chrome_version` is 140 and `setAccessLevel` sits in a try block (`test/manifest.test.js`).
- Permissions are exactly `storage`, the two API hosts and the one content-script host (`test/manifest.test.js`).
- The zip from `npm run package` contains `manifest.json` at its root and the `_locales` folder if one exists.
