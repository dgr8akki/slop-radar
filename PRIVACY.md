# Privacy policy

_Last updated: 25 September 2026_

Slop Radar is a Chrome extension that labels LinkedIn posts by how much they read like generic AI writing. It has no servers, accounts or analytics of its own.

## What is processed, and where

| Data                                                  | Where it goes                                                                                                            | Why                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| The visible text of feed posts that scroll into view  | [Vercel AI Gateway](https://vercel.com/docs/ai-gateway), which forwards it to [TypeSafe](https://typesafe.ai) to run Jev | Rating the post          |
| Ratings (a verdict, two percentages and signal names) | `chrome.storage.local` in this browser, keyed by a hash of the post text; the most recent 2,000 are kept                 | Not paying to rate twice |
| Your AI Gateway API key                               | `chrome.storage.local` in this browser only, readable only by the extension's own pages                                  | Authenticating requests  |

Slop Radar does **not** send author names, profiles, comments, messages, or anything about your own account or activity. It runs only on `www.linkedin.com`.

Requests to AI Gateway are billed to your own Vercel account and are subject to the privacy policies of [Vercel](https://vercel.com/legal/privacy-policy) and TypeSafe.

## Permissions

- **Content script on `www.linkedin.com`**: to read post text in your feed and add labels.
- **Access to `ai-gateway.vercel.sh`**: to send post text for rating.
- **`storage`**: to keep your API key and cached ratings.

## Your choices

Disable the extension to stop all rating. Removing it deletes your key and cached ratings.

## Contact

Questions: open an issue at [github.com/dgr8akki/slop-radar](https://github.com/dgr8akki/slop-radar/issues).
