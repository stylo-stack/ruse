// `ruse config` — read/write user-defined variables in one of three scopes.
//
// Scopes and precedence (highest wins on read):
//
//   1. project — <nearest .ruse/>/config.json         (checked into the repo)
//   2. user    — <user-config>/config.json            (per-user, per-machine)
//   3. global  — <user-config>/global.config.json     (per-user, portable —
//                                                     intended to be synced
//                                                     via dotfiles/etc.)
//
// The "user-config" dir mirrors the recipe layout in cli.mjs so config files
// sit next to the recipes they'd inform:
//
//   $RUSE_HOME              (if set)
//   $XDG_CONFIG_HOME/ruse   (if XDG_CONFIG_HOME set)
//   ~/.config/ruse          (default)
//
// Storage format is a flat JSON object of string keys -> JSON-serializable
// values. Numbers, booleans, strings, arrays, and objects all round-trip; we
// don't try to be clever about types. Keys must match /^[A-Za-z_][A-Za-z0-9_]*$/
// so downstream (variable substitution, env export, etc.) has a stable shape.
//
// This module owns storage only — no substitution, no interpolation into
// recipes. That is a deliberate follow-up.

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const SCOPES = ['project', 'user', 'global'];
// Precedence for reads: earlier entries win. Keep in sync with the header
// comment above and with the docs in README.md.
export const READ_PRECEDENCE = ['project', 'user', 'global'];

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Return the absolute path to the config file for a given scope, or null if
 * that scope isn't available from `cwd` (only "project" can be unavailable,
 * when no .ruse/ folder exists above cwd). This function never touches disk
 * beyond the walk-up used to find .ruse/.
 */
export function configPath(scope, cwd = process.cwd()) {
  if (scope === 'project') {
    const ruseDir = findNearestRuseDir(cwd);
    if (!ruseDir) return null;
    return join(ruseDir, 'config.json');
  }
  const base = userConfigDir();
  if (scope === 'user') return join(base, 'config.json');
  if (scope === 'global') return join(base, 'global.config.json');
  throw new Error(`Unknown scope "${scope}". Use one of: ${SCOPES.join(', ')}.`);
}

/**
 * The user-scope config dir. Honors RUSE_HOME, then XDG_CONFIG_HOME, then
 * ~/.config/ruse. Kept in lockstep with userRecipesDir() in cli.mjs — recipes
 * live at <user-config>/recipes so config files sit as siblings of them.
 */
export function userConfigDir() {
  if (process.env.RUSE_HOME) return process.env.RUSE_HOME;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'ruse');
  return join(homedir(), '.config', 'ruse');
}

/**
 * Load the raw variables object for one scope. Missing file (or missing
 * scope, e.g. project with no .ruse/) returns {}. A malformed file throws
 * with a clear message rather than silently discarding data.
 */
export function loadScope(scope, cwd = process.cwd()) {
  const p = configPath(scope, cwd);
  if (!p) return {};
  let text;
  try {
    text = readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Config file ${p} is not valid JSON: ${e.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file ${p} must be a JSON object (got ${Array.isArray(parsed) ? 'array' : typeof parsed}).`);
  }
  return parsed;
}

/**
 * Return every variable visible from `cwd`, merged in precedence order
 * (project > user > global). Each entry is { name, value, scope, path }
 * where `scope`/`path` refer to the winning source. Shadowed values are
 * omitted — this matches the shape of `listAllRecipes` in cli.mjs.
 */
export function listAll(cwd = process.cwd()) {
  const seen = new Map(); // name -> entry
  for (const scope of READ_PRECEDENCE) {
    const path = configPath(scope, cwd);
    const values = loadScope(scope, cwd);
    for (const [name, value] of Object.entries(values)) {
      if (seen.has(name)) continue; // higher-precedence scope already won
      seen.set(name, { name, value, scope, path });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Also collect *shadowed* entries — for diagnostics in `ruse config list`.
 * Same shape as listAll but each visible entry gets a `shadows: [...]` array
 * of the same-name entries in lower-precedence scopes.
 */
export function listAllWithShadows(cwd = process.cwd()) {
  const perScope = {};
  for (const scope of READ_PRECEDENCE) {
    perScope[scope] = loadScope(scope, cwd);
  }
  const names = new Set();
  for (const scope of READ_PRECEDENCE) {
    for (const k of Object.keys(perScope[scope])) names.add(k);
  }
  const out = [];
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    let winner;
    const shadows = [];
    for (const scope of READ_PRECEDENCE) {
      if (!(name in perScope[scope])) continue;
      const entry = { name, value: perScope[scope][name], scope, path: configPath(scope, cwd) };
      if (!winner) winner = entry;
      else shadows.push(entry);
    }
    winner.shadows = shadows;
    out.push(winner);
  }
  return out;
}

/**
 * Set a variable in `scope`. Creates the config file (and parent dir) if
 * missing. Returns { path, previous } where `previous` is the prior value
 * (or undefined if this is a new key).
 */
export function defineVariable(name, value, scope, cwd = process.cwd()) {
  if (!VAR_NAME_RE.test(name)) {
    throw new Error(
      `Invalid variable name "${name}". Names must match /^[A-Za-z_][A-Za-z0-9_]*$/ ` +
        `so they're safe to reference from recipes and shells.`,
    );
  }
  const path = configPath(scope, cwd);
  if (!path) {
    throw new Error(
      `Cannot write to scope "project" — no .ruse/ folder found above ${cwd}. ` +
        `Run "ruse init" first, or pass --scope user|global.`,
    );
  }
  const current = loadScope(scope, cwd);
  const previous = current[name];
  const next = { ...current, [name]: value };
  mkdirSync(dirname(path), { recursive: true });
  // Pretty-print so the file is human-editable; trailing newline matches
  // the rest of the tool's file-writing conventions.
  writeFileSync(path, JSON.stringify(sortKeys(next), null, 2) + '\n');
  return { path, previous };
}

// Keep JSON output stable so diffs stay tidy in project-scope files that
// end up in git. Sort keys shallowly — that's enough for a flat config.
function sortKeys(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

// Same walk-up as cli.mjs::findNearestRuseDir. Duplicated to keep config.mjs
// self-contained and free of a cli.mjs import cycle.
function findNearestRuseDir(startDir) {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, '.ruse');
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // not there; keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Parse the value argument from `ruse config define <name> <value>`. We
 * attempt JSON first (so "42", "true", "null", '["a","b"]', '{"k":1}' all
 * round-trip as their real types), and fall back to the raw string. This
 * matches how most CLIs handle typed values without a separate --type flag.
 */
export function parseValueArg(raw) {
  if (raw == null) return '';
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Format a value for display in `ruse config list`. Strings show unquoted;
 * everything else goes through JSON so nested shapes stay readable.
 */
export function formatValue(v) {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
