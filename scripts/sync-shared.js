/**
 * Keeps the files listed in SHARED.md identical to a pinned commit of the
 * shared repo (https://github.com/dgr8akki/jev-shared).
 *
 *   node scripts/sync-shared.js           re-copy every file at the pinned commit
 *   node scripts/sync-shared.js <ref>     copy from <ref> (sha, branch or tag) and pin its commit
 *   node scripts/sync-shared.js --check   exit 1 when any local copy differs from the pinned commit
 *
 * Files are read from raw.githubusercontent.com. While the shared repo is
 * private, set JEV_SHARED_TOKEN (or GITHUB_TOKEN) and files are read through
 * the GitHub contents API with that token instead. With `--from <dir>` (or the
 * JEV_SHARED_DIR environment variable) they are read from a local clone with
 * `git show`, which also works offline and needs no token.
 *
 * No dependencies: Node 22 only. This file is itself listed in SHARED.md.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MANIFEST = 'SHARED.md';
const SHA = /^[0-9a-f]{40}$/;

/**
 * Reads the upstream URL, pinned commit and file table out of a SHARED.md.
 *
 * @param {string} text
 * @returns {{ upstream: string, commit: string | null, files: { from: string, to: string, note: string }[] }}
 */
export function parseShared(text) {
  const upstream = text.match(/^-\s*Upstream:\s*<?(\S+?)>?\s*$/m)?.[1];
  if (!upstream) throw new Error(`${MANIFEST} has no "- Upstream: <url>" line.`);
  const commit = text.match(/^-\s*Commit:\s*`?([0-9a-f]{40})`?\s*$/m)?.[1] ?? null;

  const files = [];
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line
      .trim()
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    if (cells[0].toLowerCase() === 'upstream path' || /^:?-+:?$/.test(cells[0])) continue;
    files.push({ from: cells[0].replace(/`/g, ''), to: cells[1].replace(/`/g, ''), note: cells[2] ?? '' });
  }
  if (!files.length)
    throw new Error(`${MANIFEST} lists no files (expected a table with Upstream path and Local path).`);
  return { upstream, commit, files };
}

/** Replaces the pinned commit in a SHARED.md, keeping everything else byte for byte. */
export function pinCommit(text, sha) {
  const line = /^(-\s*Commit:\s*`?)([0-9a-f]{40}|<[^>]*>|TODO|\S*)(`?\s*)$/m;
  if (!line.test(text)) throw new Error(`${MANIFEST} has no "- Commit:" line to update.`);
  return text.replace(line, `$1${sha}$3`);
}

/**
 * Where upstream bytes come from: a local clone (git show) or GitHub raw files.
 *
 * @param {{ dir?: string, upstream: string, fetchImpl?: typeof fetch, token?: string }} options
 *   `token` (a GitHub token) switches file reads to the contents API, which a private repo needs.
 */
export function createSource({ dir, upstream, fetchImpl = (...args) => fetch(...args), token }) {
  if (dir) {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      describe: () => `local clone at ${dir}`,
      resolve: (ref) => git('rev-parse', '--verify', `${ref}^{commit}`).toString().trim(),
      read: (commit, path) => git('show', `${commit}:${path}`),
    };
  }

  const [owner, repo] = new URL(upstream).pathname.replace(/^\/|\.git$|\/$/g, '').split('/');
  if (!owner || !repo) throw new Error(`Cannot read owner/repo from upstream URL ${upstream}`);
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  const get = async (url, headers = {}) => {
    const res = await fetchImpl(url, { headers: { ...auth, ...headers } });
    if (!res.ok) {
      const hint =
        res.status === 404 && !token ? ' If the upstream repo is private, set JEV_SHARED_TOKEN to a GitHub token.' : '';
      throw new Error(`GET ${url} failed (HTTP ${res.status}).${hint}`);
    }
    return res;
  };
  return {
    describe: () => `${owner}/${repo} on GitHub${token ? ' (authenticated)' : ''}`,
    async resolve(ref) {
      if (SHA.test(ref)) return ref;
      const res = await get(`https://api.github.com/repos/${owner}/${repo}/commits/${ref}`, {
        Accept: 'application/vnd.github.sha',
      });
      const sha = (await res.text()).trim();
      if (!SHA.test(sha)) throw new Error(`GitHub did not return a commit for "${ref}": ${sha.slice(0, 80)}`);
      return sha;
    },
    async read(commit, path) {
      // raw.githubusercontent.com does not take tokens reliably; the contents API serves the same bytes.
      const res = token
        ? await get(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${commit}`, {
            Accept: 'application/vnd.github.raw+json',
          })
        : await get(`https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${path}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

/**
 * @param {string[]} argv Arguments after the script name.
 * @param {{ root?: string, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, log?: (line: string) => void }} [io]
 * @returns {Promise<number>} Exit code.
 */
export async function run(argv, { root = process.cwd(), env = process.env, fetchImpl, log = console.log } = {}) {
  let check = false;
  let dir = env.JEV_SHARED_DIR;
  let ref;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') check = true;
    else if (argv[i] === '--from') dir = argv[++i];
    else if (argv[i].startsWith('-')) throw new Error(`Unknown option ${argv[i]}`);
    else ref = argv[i];
  }
  if (check && ref) throw new Error('--check compares against the pinned commit; it takes no ref.');

  const manifestPath = join(root, MANIFEST);
  if (!existsSync(manifestPath)) {
    throw new Error(`No ${MANIFEST} in ${root}. See https://github.com/dgr8akki/jev-shared/blob/main/SHARED.md`);
  }
  const text = readFileSync(manifestPath, 'utf8');
  const { upstream, commit: pinned, files } = parseShared(text);
  const token = env.JEV_SHARED_TOKEN || env.GITHUB_TOKEN || undefined;
  const source = createSource({ dir, upstream, fetchImpl, token });

  if (check) {
    if (!pinned) throw new Error(`${MANIFEST} pins no commit; run "node scripts/sync-shared.js <ref>" first.`);
    const drifted = [];
    for (const { from, to } of files) {
      const expected = await source.read(pinned, from);
      const local = join(root, to);
      if (!existsSync(local)) drifted.push(`${to} is missing`);
      else if (!expected.equals(readFileSync(local))) drifted.push(`${to} differs from ${from}`);
    }
    for (const line of drifted) log(`drift: ${line}`);
    if (drifted.length) {
      log(`${drifted.length} of ${files.length} shared files differ from ${upstream} @ ${pinned.slice(0, 7)}.`);
      log('Run "node scripts/sync-shared.js" to restore them, or change them upstream and re-sync.');
      return 1;
    }
    log(`${files.length} shared files match ${upstream} @ ${pinned.slice(0, 7)}.`);
    return 0;
  }

  if (!ref && !pinned) throw new Error(`${MANIFEST} pins no commit; pass a ref: node scripts/sync-shared.js main`);
  const commit = await source.resolve(ref ?? pinned);
  for (const { from, to } of files) {
    const bytes = await source.read(commit, from);
    const local = join(root, to);
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, bytes);
    log(`copied ${to}`);
  }
  if (commit !== pinned) {
    writeFileSync(manifestPath, pinCommit(text, commit));
    log(`pinned ${MANIFEST} to ${commit.slice(0, 7)}`);
  }
  log(`${files.length} files from ${source.describe()} @ ${commit.slice(0, 7)}.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
