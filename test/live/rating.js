// Rates a handful of sample posts with the real model and checks the verdicts and the signals that
// should fire. It costs a fraction of a cent, needs a key (see .env.example), and is not part of
// `npm test`; run it with `npm run eval` after touching QUESTIONS or the thresholds.
import { createJevClient } from '../../src/lib/jev.js';
import { QUESTIONS, SIGNALS, toRating } from '../../src/lib/rating.js';

// The provider rate-limits bursts and TypeSafe has short outages, so a case gets a few tries.
const TRIES = 5;

// [expected verdict, or null for "no opinion"; signals that must fire; the post]
// Paraphrased from posts seen in a real feed; swap in your own when the feed changes character.
const samples = [
  [
    'slop',
    [SIGNALS.hook, SIGNALS.bait],
    `Nobody talks about this part of getting promoted.

You don't get promoted for doing your job well.
You get promoted for making your manager's job easier.

Read that again.

Save this for the next time you're overlooked, and repost so your network sees it too.`,
  ],
  [
    'human',
    [SIGNALS.specific],
    `Our Postgres migration on Thursday stalled for forty minutes because two runners in CI disagreed about the time by four minutes. One took the advisory lock, the other decided it had expired and grabbed it too. Pinned NTP on the self-hosted boxes and it hasn't happened since. Twelve-line patch, link in the first comment.`,
  ],
  [
    'human',
    [],
    `We're at the Dublin Tech Summit until Thursday, stand B14, mostly talking to people about how they handle refunds across currencies. Come and argue with us about it; there's coffee.`,
  ],
  [
    'slop',
    [SIGNALS.format],
    `5 things I wish I knew at 25:

→ Your network is your net worth
→ Rest is productive
→ Say no more often
→ Nobody is thinking about you as much as you think
→ Consistency beats intensity

Which one hit hardest?`,
  ],
  [
    null,
    [],
    `After six years I'm leaving Northwind on Friday. Proud of what the payments team shipped and grateful to the people who put up with my code reviews. Starting something new in October; more on that soon.`,
  ],
];

// TYPESAFE_API_KEY calls TypeSafe directly; otherwise AI_GATEWAY_API_KEY goes through Vercel.
const provider = process.env.TYPESAFE_API_KEY ? 'typesafe' : 'vercel';
const key = process.env.TYPESAFE_API_KEY || process.env.AI_GATEWAY_API_KEY;
if (!key) {
  console.error('Set TYPESAFE_API_KEY or AI_GATEWAY_API_KEY (see .env.example) to run the live check.');
  process.exit(1);
}
console.log(`Provider: ${provider}\n`);
const jev = createJevClient({ getKey: () => key, getProvider: () => provider });

/** Rates one post, sitting out rate limits and 5xx outages; any other error is the case's own. */
async function rate(text) {
  let tries = TRIES;
  for (;;) {
    try {
      return toRating(await jev.evaluate({ state: text, questions: QUESTIONS }));
    } catch (error) {
      const outage = error.status >= 500;
      if (!(error.busy || outage) || (tries -= 1) === 0) throw error;
      const seconds = error.retryAfter || 5 * (TRIES - tries);
      process.stdout.write(`  (${outage ? 'provider outage' : 'rate-limited'}, back in ${seconds}s)\n`);
      await new Promise((resolve) => setTimeout(resolve, (seconds + 1) * 1000));
    }
  }
}

let failures = 0;
for (const [expected, mustSignal, text] of samples) {
  const name = `${text.split('\n')[0].slice(0, 44)}…`;
  try {
    const rating = await rate(text);
    const verdictOk = expected === null || rating.verdict === expected;
    const signalsOk = mustSignal.every((s) => rating.signals.includes(s));
    const ok = verdictOk && signalsOk;
    failures += ok ? 0 : 1;
    console.log(
      `${ok ? 'pass' : 'FAIL'}  ${name.padEnd(48)} ${rating.verdict} (slop ${Math.round(rating.slop * 100)}%, human ${Math.round(rating.human * 100)}%) [${rating.signals.join(', ')}]`,
    );
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name.padEnd(48)} ${error.message}`);
  }
}

console.log(failures ? `\n${failures} failed` : `\nAll ${samples.length} passed`);
process.exit(failures ? 1 : 0);
