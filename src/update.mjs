// `ruse update` — check GitHub for a newer version and (optionally) install it.
//
// This is deterministic plumbing: no LLM calls, no dependencies. It talks to the
// GitHub REST API to learn about releases and commits, then hands the install
// off to whichever package manager the user chose (pnpm by default, npm or
// yarn if flagged). The install command matches each PM's documented syntax
// for installing from a GitHub repo.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const REPO = 'stylo-stack/ruse';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const COMMITS_URL = `https://api.github.com/repos/${REPO}/commits/main`;

// Where we remember the SHA installed by `ruse update --dev`. Sits alongside
// the user recipes dir so it obeys the same RUSE_HOME / XDG override chain.
function devMarkerPath() {
  if (process.env.RUSE_HOME) return join(process.env.RUSE_HOME, '.installed-sha');
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'ruse', '.installed-sha');
  return join(homedir(), '.config', 'ruse', '.installed-sha');
}

// Read the currently installed version from our own package.json — same source
// `ruse --version` uses, so users see consistent numbers.
function currentVersion() {
  const url = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')).version;
}

// Read the SHA we last installed in --dev mode, if any. Missing file is fine.
function readInstalledSha() {
  try {
    return readFileSync(devMarkerPath(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writeInstalledSha(sha) {
  const p = devMarkerPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, sha + '\n', 'utf8');
  } catch {
    // Non-fatal: we just lose the "already up to date" hint on next check.
  }
}

// Tiny semver comparator — enough for x.y.z (with optional -prerelease).
// Returns >0 if a>b, <0 if a<b, 0 if equal. Non-numeric parts sort lexically
// (so "1.0.0" > "1.0.0-rc.1", matching semver's "prerelease < release").
function compareVersions(a, b) {
  const parse = (v) => {
    const clean = String(v).replace(/^v/, '');
    const [core, pre] = clean.split('-');
    return { core: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const A = parse(a), B = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (A.core[i] ?? 0) - (B.core[i] ?? 0);
    if (d !== 0) return d;
  }
  if (A.pre && !B.pre) return -1; // 1.0.0-rc < 1.0.0
  if (!A.pre && B.pre) return 1;
  if (A.pre && B.pre) return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0;
  return 0;
}

// GET JSON from GitHub. UA is required by the REST API. Times out after 10s so
// a wedged network can't hang the CLI. Returns { ok, data, status } so the
// caller can distinguish 404 (e.g. "no releases yet") from a real error.
async function ghFetch(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ruse-cli', Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, status: res.status, statusText: res.statusText };
    }
    return { ok: true, status: res.status, data: await res.json() };
  } finally {
    clearTimeout(t);
  }
}

// Parse the flags this subcommand cares about. Everything else the CLI passed
// is treated as unknown and rejected so typos ("--dry" vs "--dev") surface loudly.
export function parseUpdateFlags(argv) {
  const flags = { check: false, dev: false, pm: null };
  const pmFlags = [];
  for (const a of argv) {
    if (a === '--check') flags.check = true;
    else if (a === '--dev') flags.dev = true;
    else if (a === '--npm') { flags.pm = 'npm'; pmFlags.push(a); }
    else if (a === '--pnpm') { flags.pm = 'pnpm'; pmFlags.push(a); }
    else if (a === '--yarn') { flags.pm = 'yarn'; pmFlags.push(a); }
    else return { ok: false, message: `Unknown option "${a}" for \`ruse update\`.` };
  }
  if (pmFlags.length > 1) {
    return { ok: false, message: `Pass only one of ${pmFlags.join(', ')} — they're mutually exclusive.` };
  }
  if (!flags.pm) flags.pm = 'pnpm'; // spec: pnpm is the default
  return { ok: true, flags };
}

// Build the install command for the selected package manager. Each string
// below matches the PM's documented syntax for installing from GitHub:
//   npm:  npm install -g github:owner/repo[#ref]
//   pnpm: pnpm add    -g github:owner/repo[#ref]
//   yarn: yarn global add github:owner/repo[#ref]   (v1 / classic)
function installCommand(pm, ref) {
  const spec = ref ? `github:${REPO}#${ref}` : `github:${REPO}`;
  if (pm === 'npm') return { cmd: 'npm', args: ['install', '-g', spec] };
  if (pm === 'pnpm') return { cmd: 'pnpm', args: ['add', '-g', spec] };
  if (pm === 'yarn') return { cmd: 'yarn', args: ['global', 'add', spec] };
  throw new Error(`Unknown package manager "${pm}"`);
}

// Yes/no prompt on stdin. Default no — install is a big enough change that we
// want the user to explicitly say "yes".
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((res) => rl.question(`${question} [y/N] `, res));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// Run the install command with the child's stdio wired straight through so the
// user sees pnpm/npm/yarn's progress and any prompts (e.g. sudo) live.
function runInstall(cmd, args) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', (e) => {
      if (e.code === 'ENOENT') {
        rej(new Error(`Couldn't find "${cmd}" on your PATH. Install it or pass a different package manager (e.g. --npm).`));
      } else {
        rej(e);
      }
    });
    child.on('close', (code) => {
      if (code === 0) res();
      else rej(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

/**
 * Entry point for `ruse update [--check] [--dev] [--npm|--pnpm|--yarn]`.
 * Split into check and install phases so `--check` can bail out early.
 */
export async function update(argv) {
  const parsed = parseUpdateFlags(argv);
  if (!parsed.ok) {
    process.stderr.write(parsed.message + '\n');
    process.exitCode = 1;
    return;
  }
  const { check, dev, pm } = parsed.flags;
  const cur = currentVersion();

  // --- Fetch what "latest" means for the chosen channel --------------------
  let target; // { ref: string|null, label: string, newer: boolean, upToDate: boolean }
  try {
    if (dev) {
      const r = await ghFetch(COMMITS_URL);
      if (!r.ok) throw new Error(`GitHub API ${r.status} ${r.statusText}`);
      const sha = r.data.sha;
      const shortSha = sha.slice(0, 7);
      const installedSha = readInstalledSha();
      const upToDate = installedSha === sha;
      target = {
        ref: 'main',
        sha,
        label: `main @ ${shortSha}`,
        newer: !upToDate,
        upToDate,
        installedSha,
      };
    } else {
      const r = await ghFetch(RELEASES_URL);
      if (r.status === 404) {
        // No releases published yet — this is a real state during early
        // development, not an error. Point the user at --dev and stop.
        process.stdout.write(`ruse: installed v${cur}\n`);
        process.stdout.write(`No GitHub Releases published yet for ${REPO}.\n`);
        process.stdout.write(`Track the main branch with:  ruse update --dev${check ? ' --check' : ''}\n`);
        return;
      }
      if (!r.ok) throw new Error(`GitHub API ${r.status} ${r.statusText}`);
      const tag = r.data.tag_name;
      const latest = tag.replace(/^v/, '');
      const cmp = compareVersions(latest, cur);
      target = {
        ref: null, // release install pins to default branch/tag semantics
        tag,
        latest,
        label: `v${latest}`,
        newer: cmp > 0,
        upToDate: cmp <= 0,
      };
    }
  } catch (e) {
    process.stderr.write(`Couldn't reach GitHub to check for updates: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }

  // --- Report ---------------------------------------------------------------
  const channel = dev ? 'dev (main branch)' : 'release';
  process.stdout.write(`ruse: installed v${cur}\n`);
  process.stdout.write(`      latest ${channel}: ${target.label}\n`);
  if (dev && target.installedSha) {
    process.stdout.write(`      last --dev install: ${target.installedSha.slice(0, 7)}\n`);
  }

  if (target.upToDate) {
    process.stdout.write(`Already up to date.\n`);
    return;
  }

  const { cmd, args } = installCommand(pm, dev ? 'main' : null);
  const cmdLine = `${cmd} ${args.join(' ')}`;

  if (check) {
    process.stdout.write(`Update available. Run: ruse update${dev ? ' --dev' : ''}${pm !== 'pnpm' ? ` --${pm}` : ''}\n`);
    process.stdout.write(`  (would run: ${cmdLine})\n`);
    return;
  }

  // --- Install --------------------------------------------------------------
  process.stdout.write(`Will run: ${cmdLine}\n`);
  const ok = await confirm('Proceed?');
  if (!ok) {
    process.stdout.write('Aborted.\n');
    return;
  }
  try {
    await runInstall(cmd, args);
  } catch (e) {
    process.stderr.write(`Install failed: ${e.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (dev) writeInstalledSha(target.sha);
  process.stdout.write(`\nDone. Verify with: ruse --version\n`);
}
