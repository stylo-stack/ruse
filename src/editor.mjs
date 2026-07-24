// Editor detection + "open a directory in the user's editor" plumbing.
// Shared by `ruse edit` (explicit open) and `ruse recipes new` (post-authoring
// prompt). Kept dependency-free — a `which` probe plus `spawn` is enough.
//
// The order matches what `git`, `gh`, and most CLIs do:
//   1. $VISUAL  (traditionally the "fancy" editor)
//   2. $EDITOR  (traditionally the fallback terminal editor)
//   3. Well-known IDE CLIs on PATH, in a reasonable priority order.
//   4. Platform fallback: `open` on macOS, `xdg-open` on Linux.
//
// A resolved editor is `{ cmd, args, source }` where `source` is a short label
// used only in messages (e.g. "$VISUAL", "PATH:code"). Callers should not rely
// on the exact string.

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// IDE CLIs we probe on PATH, in priority order. Order is deliberate: `code`
// and `cursor` are the most common day-driver editors right now; then a few
// popular alternatives; then JetBrains as a heavier fallback. Everyone here
// accepts a path argument and opens it, which is the whole contract.
const IDE_CANDIDATES = [
  'code',      // VS Code
  'cursor',    // Cursor
  'windsurf',  // Codeium Windsurf
  'zed',       // Zed
  'subl',      // Sublime Text
  'idea',      // JetBrains IntelliJ
];

/**
 * Resolve the user's preferred editor. Never throws; returns `null` when we
 * cannot find anything to open with (extremely rare — the platform fallback
 * usually catches it).
 *
 * The returned object is spawn-ready: `spawn(cmd, [...args, path])` will do
 * the right thing. `source` is a human label for logs, not a stable API.
 *
 * @returns {{ cmd: string, args: string[], source: string } | null}
 */
export function resolveEditor() {
  // 1 & 2. $VISUAL then $EDITOR. These are shell command strings (e.g. `vim`
  // or `code --wait`), so we split on whitespace — same trick git uses. This
  // is intentionally simple; anyone with a truly gnarly editor command can
  // set VISUAL to a shim script.
  for (const varName of ['VISUAL', 'EDITOR']) {
    const raw = process.env[varName];
    if (raw && raw.trim()) {
      const parts = raw.trim().split(/\s+/);
      return { cmd: parts[0], args: parts.slice(1), source: `$${varName}` };
    }
  }

  // 3. Common IDE CLIs on PATH. `command -v` via spawnSync is portable and
  // avoids assumptions about shell built-ins. We stop at the first hit.
  for (const cli of IDE_CANDIDATES) {
    if (hasOnPath(cli)) {
      return { cmd: cli, args: [], source: `PATH:${cli}` };
    }
  }

  // 4. Platform fallback. `open` is macOS-only; `xdg-open` is the standard
  // freedesktop.org opener on Linux. Windows would use `start`, but that's a
  // cmd.exe built-in and we deliberately do not support it here — Windows
  // users should set $VISUAL/$EDITOR explicitly.
  if (process.platform === 'darwin' && hasOnPath('open')) {
    return { cmd: 'open', args: [], source: 'PATH:open' };
  }
  if (process.platform === 'linux' && hasOnPath('xdg-open')) {
    return { cmd: 'xdg-open', args: [], source: 'PATH:xdg-open' };
  }
  return null;
}

/**
 * Human-readable list of what we'd try, in order. Used in the "no editor
 * found" error message so users can see the fallback chain without needing
 * to read source.
 */
export function editorCandidatesHint() {
  return `$VISUAL, $EDITOR, then one of: ${IDE_CANDIDATES.join(', ')} (or \`open\`/\`xdg-open\`)`;
}

/**
 * Open `path` in the user's editor. Detaches the child so terminal editors
 * (vim, nvim) can attach to the current TTY, and GUI editors (code, cursor)
 * survive after `ruse` exits.
 *
 * Returns the resolved editor spec on success, or `null` if none was found.
 * Does not wait for the child — spawning is fire-and-forget by design.
 */
export function openInEditor(path) {
  const ed = resolveEditor();
  if (!ed) return null;
  // Terminal editors (vim, emacs, nano) need stdio inherited so they can
  // paint the current TTY. GUI editors (code, cursor, open, xdg-open) don't
  // care — they return immediately. Inheriting in both cases is fine; the
  // GUI ones just exit quickly.
  const child = spawn(ed.cmd, [...ed.args, path], {
    stdio: 'inherit',
    detached: false,
  });
  // Swallow errors from the child so a failed spawn doesn't crash the caller
  // — the caller has already committed to the "open" gesture at this point.
  child.on('error', () => {});
  return ed;
}

// Portable "is this command on PATH?" check. `command -v` is defined by POSIX
// and works in every Unix shell we care about; on Windows we'd fall through to
// the $VISUAL/$EDITOR path anyway, so we don't bother with `where`.
//
// Pass the probe as a single shell string (not [cmd, args, shell:true]) — the
// latter form triggers a Node deprecation warning (DEP0190) because argv is
// concatenated unquoted. Since `cmd` here is one of our own allowlisted strings
// (IDE_CANDIDATES / 'open' / 'xdg-open'), there's no injection surface.
function hasOnPath(cmd) {
  try {
    const r = spawnSync(`command -v ${cmd}`, { stdio: 'ignore', shell: true });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Snapshot a directory tree as a map of relative-path → mtime-ms. Missing
 * dirs return an empty map (so a diff against a later snapshot naturally
 * shows every new file as changed).
 *
 * Cheap enough to run twice around a `spawnSync('claude', ...)` — recipes
 * dirs are typically dozens of small files, not thousands. If that ever
 * changes we can swap in a single top-level mtime check.
 */
export function snapshotDir(dir) {
  const out = new Map();
  walk(dir, dir, out);
  return out;
}

function walk(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing or unreadable dir — treat as empty
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, abs, out);
    } else if (entry.isFile()) {
      try {
        const st = statSync(abs);
        // Key by absolute path so callers don't need to know the root.
        out.set(abs, st.mtimeMs);
      } catch {
        // File vanished between readdir and stat — ignore.
      }
    }
  }
}

/**
 * True iff `after` differs from `before` in any file (added, removed, or
 * mtime changed). We deliberately treat mtime-only changes as "changed" —
 * an agent that `touch`es a file counts as activity worth prompting about.
 */
export function snapshotsDiffer(before, after) {
  if (before.size !== after.size) return true;
  for (const [path, mtime] of after) {
    if (before.get(path) !== mtime) return true;
  }
  return false;
}

/**
 * Yes/no prompt on stdin. Default is configurable ("y" or "n"); the default
 * is capitalized in the "[Y/n]" / "[y/N]" suffix to match the convention used
 * elsewhere in ruse (see `update.mjs`'s `confirm`). Returns a boolean.
 */
export async function confirm(question, { default: def = 'n' } = {}) {
  const suffix = def === 'y' ? '[Y/n]' : '[y/N]';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((res) => rl.question(`${question} ${suffix} `, res));
    const a = answer.trim().toLowerCase();
    if (!a) return def === 'y';
    return /^y(es)?$/.test(a);
  } finally {
    rl.close();
  }
}
