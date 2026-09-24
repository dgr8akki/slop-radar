// Live evaluation against the real Jev model: rates hand-written sample posts
// and checks the verdicts. Needs AI_GATEWAY_API_KEY (see .env.example); not run in CI.
//
//   npm run eval
//
// TypeSafe rate-limits bursts and has brief outages, so each case waits and retries.
import { createJevClient } from '../src/lib/jev.js';
import { QUESTIONS, SIGNALS, toRating } from '../src/lib/rating.js';

const MAX_ATTEMPTS = 6;

// [expected verdict or null for "any", expected signals that must fire, post]
const samples = [
  [
    'slop',
    [SIGNALS.hook, SIGNALS.format, SIGNALS.bait],
    `I got rejected from 47 jobs.

Then everything changed.

Here's the thing nobody tells you:

👉 Consistency beats talent
👉 Your network is your net worth
👉 Failure is just feedback

It's not about the destination. It's about the journey.

Let that sink in.

Agree? ♻️ Repost to help someone in your network.`,
  ],
  [
    'human',
    [SIGNALS.specific],
    `Spent Tuesday debugging a flaky Postgres migration with Priya. Turned out our CI runner's clock was 4 minutes off, so the advisory lock expired mid-run and a second job grabbed it. Fix was pinning NTP on the self-hosted runners. The 12-line patch and a short writeup are in the comments if anyone else hits this on GitHub Actions.`,
  ],
  [
    'human',
    [],
    `Great to be at Web Summit Lisbon this week with the team. Some really interesting conversations about AI in fintech and where regulation is heading. If you're around, come say hi at booth C42, we're demoing the new onboarding flow.`,
  ],
  [
    'slop',
    [],
    `Leadership isn't about titles. It's about showing up for your people every single day. The best leaders I've worked with listened more than they spoke, gave credit freely, and took the blame when things went wrong. What's the best leadership lesson you've learned?`,
  ],
  [
    null,
    [],
    `Thrilled to announce that I've joined Acme as a Senior Product Manager! Grateful to my incredible team at Foo for three amazing years of growth and learning. Excited for this next chapter and can't wait to build the future of payments together. 🚀`,
  ],
];

if (!process.env.AI_GATEWAY_API_KEY) {
  console.error('Set AI_GATEWAY_API_KEY (see .env.example) to run the live evaluation.');
  process.exit(1);
}
const jev = createJevClient({ getKey: () => process.env.AI_GATEWAY_API_KEY });

/** Runs `fn`, waiting out rate limits and outages; other errors fail the case. */
async function withRetry(fn) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      // Rate limits and TypeSafe outages are infrastructure, not wrong answers: wait and retry.
      const outage = error.status >= 500;
      if (!(error.busy || outage) || attempt === MAX_ATTEMPTS) throw error;
      const wait = error.retryAfter || 5 * attempt;
      process.stdout.write(`  (${outage ? 'service unavailable' : 'rate-limited'}, waiting ${wait}s)\n`);
      await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
    }
  }
}

let failures = 0;
for (const [expected, mustSignal, text] of samples) {
  const name = `${text.split('\n')[0].slice(0, 44)}…`;
  try {
    const rating = toRating(await withRetry(() => jev.evaluate({ state: text, questions: QUESTIONS })));
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
