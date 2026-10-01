# Privacy policy

_Revised 30 September 2026. Every change to this page is in the repo's commit history._

Slop Radar tags posts in your LinkedIn feed by how much they read like generic AI writing. I don't run a server for it and it doesn't phone home to me. What follows is everything that moves and where it goes.

## What gets sent

**Post text.** When a post scrolls into view, its visible text is sent to the provider you chose in settings: [TypeSafe](https://typesafe.ai) itself, or TypeSafe by way of [Vercel AI Gateway](https://vercel.com/docs/ai-gateway). That is the whole request: the text, the six fixed questions, and your key.

**Your API key.** It travels in the `Authorization` header of every rating request, and once more when you press Connect or Test on the settings page, which sends a one-word test request to check the key works. It is never sent anywhere else.

It never sends the author's name, their profile, comments, your messages, or anything about your own account or what you do on the site. Only post text. Post text can of course contain other people's names, which is why the popover says "Only the post's text is sent, never the author's name or profile" rather than promising more than that.

You pay for those requests on your own TypeSafe or Vercel account, and their privacy policies apply to them ([TypeSafe](https://typesafe.ai), [Vercel](https://vercel.com/legal/privacy-policy)).

## What stays in your browser

| Data                                                  | Where                                                                                                          | Why                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------- |
| The key, and whose it is                              | `chrome.storage.local`, readable by the extension's own pages only; the LinkedIn page cannot read it           | Signing requests            |
| Ratings (a verdict, two percentages and signal names) | `chrome.storage.local`, one entry per post keyed by a hash of its text; roughly the most recent 2,000 are kept | Not paying to rate twice    |
| A rate-limit pause                                    | `chrome.storage.session`, cleared when Chrome closes                                                           | Waiting out a busy provider |

## What the manifest asks for

The content script runs on `www.linkedin.com` only, to read post text in your feed and add the tags. The extension can reach `api.typesafe.ai` and `ai-gateway.vercel.sh`, and talks to whichever one you picked; nothing goes to the other. `storage` keeps the key and the cache.

## Off switches

Disable the extension to stop all rating. Remove it and Chrome deletes the key and the cached ratings with it. Removing the key on the settings page stops rating too; the feed shows one card offering to reconnect instead of tags.

## If something here is unclear

Write to pahujaaakash5@gmail.com. Bugs and requests belong in the [issue tracker](https://github.com/dgr8akki/slop-radar/issues), where other people can see the answer too.
