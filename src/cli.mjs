#!/usr/bin/env node
// `ruse` — run a recipe that interleaves deterministic scripts with LLM prompts.

import { resolve, dirname, join, basename, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { statSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { makeKit, Ledger } from './runtime.mjs';
import { init, initGlobal } from './init.mjs';
import { update } from './update.mjs';
import {
  SCOPES,
  configPath,
  defineVariable,
  formatValue,
  listAllWithShadows,
  parseValueArg,
} from './config.mjs';
import { runRecipesSub, recipesSubcommands } from './recipes.mjs';
import { openInEditor, editorCandidatesHint } from './editor.mjs';
import { mkdirSync } from 'node:fs';

// Block-letter wordmark shown on bare `ruse`, `--help`, and `--version`. Kept
// ASCII inside the block so it renders in every terminal; the caption's em-dash
// mirrors non-ASCII already present in HELP. See renderBanner() for coloring.
const BANNER_BLOCK = [
  '  _ __ _   _ ___  ___',
  " | '__| | | / __|/ _ \\",
  ' | |  | |_| \\__ \\  __/',
  ' |_|   \\__,_|___/\\___|',
];
const BANNER_CAPTION = ' rational Use — humans, using AI';

// ANSI helpers. We only emit codes when stdout is a real TTY and NO_COLOR is
// unset (https://no-color.org). Callers pass `color: false` to force plain.
const ANSI = { bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m' };
function colorEnabled() {
  if (process.env.NO_COLOR && process.env.NO_COLOR.length > 0) return false;
  return Boolean(process.stdout.isTTY);
}

// Render the banner. When color is on, block letters are bold and the caption
// is dim — except `r` and `U` in "rational Use", which stay un-dimmed so they
// echo the wordmark. When color is off we just return the plain lines.
function renderBanner({ color = colorEnabled() } = {}) {
  const lines = [];
  if (color) {
    for (const l of BANNER_BLOCK) lines.push(`${ANSI.bold}${l}${ANSI.reset}`);
    lines.push('');
    // Highlight the leading `r` of "rational" and the `U` of "Use" by leaving
    // them at normal intensity while the rest of the caption is dimmed.
    const cap = BANNER_CAPTION;
    const rIdx = cap.indexOf('r'); // first 'r' — starts "rational"
    const uIdx = cap.indexOf('U'); // 'U' — starts "Use"
    let out = '';
    for (let i = 0; i < cap.length; i++) {
      const ch = cap[i];
      if (i === rIdx || i === uIdx) {
        out += `${ANSI.reset}${ch}${ANSI.dim}`;
      } else {
        out += ch;
      }
    }
    lines.push(`${ANSI.dim}${out}${ANSI.reset}`);
  } else {
    for (const l of BANNER_BLOCK) lines.push(l);
    lines.push('');
    lines.push(BANNER_CAPTION);
  }
  return lines.join('\n') + '\n';
}

// Print the banner only when stdout is a TTY. Piped/redirected/CI output stays
// clean so `ruse --help | cat` and log capture don't see decoration.
function maybePrintBanner() {
  if (!process.stdout.isTTY) return;
  process.stdout.write(renderBanner() + '\n');
}

// Read version lazily from package.json. Kept as a function so `ruse run` and
// friends never touch the file — only the version path pays for it.
function readVersion() {
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(url, 'utf8'));
  return pkg.version;
}

const HELP = `ruse — rational use of LLMs

Usage:
  ruse init [dir]                        Scaffold a .ruse/ folder in a project.
  ruse init --global                     Seed global recipes into <user-recipes>.
  ruse run <recipe> [--dry-run] [-- ...args]
  ruse recipes                           List every recipe visible from cwd.
  ruse recipes new                       Author a new recipe interactively via
                                         the recipe-author agent (writes into
                                         the global ruse dir).
  ruse recipes explain                   Ask the recipe-guide agent how the kit
                                         works, patterns, and the "minimize LLM
                                         use" philosophy. Read-only.
  ruse edit                              Open the global ruse dir in your editor
                                         ($VISUAL, $EDITOR, or a detected IDE).
  ruse update [--check] [--dev] [--npm|--pnpm|--yarn]
                                         Check GitHub and (re)install ruse.
  ruse config list [--scope <s>]         List variables (project > user > global).
  ruse config define <name> <value>      Set a variable (default scope: project).
    [--scope project|user|global]
  ruse completion <bash|zsh|fish>        Print a shell completion script.

<recipe> can be either a path to a recipe file (e.g. .ruse/foo.recipe.mjs)
or a short name (e.g. foo). Short names are resolved in this order:
  1. Nearest .ruse/<name>.recipe.mjs walking up from cwd    [project scope]
  2. Nearest .ruse/<name>.mjs
  3. <user-recipes>/<name>.recipe.mjs                       [global scope]
  4. <user-recipes>/<name>.mjs
Project scope always shadows global. <user-recipes> is $RUSE_HOME/recipes if
set, else $XDG_CONFIG_HOME/ruse/recipes, else ~/.config/ruse/recipes.

A recipe is a JS module whose default export is an async function:

  export default async function ({ ask, run, sh, prompt, agent, context, handoff, state }) {
    const file = await ask('Which file to summarize?');
    const text = await run('scripts/read.sh', { args: [file] });   // deterministic
    const { text: summary } = await prompt('prompts/summarize.md', {// LLM (opt-in)
      model: 'haiku', input: text,
    });
    console.log(summary);
  }

Options:
  --dry-run   Skip LLM calls; print which steps would spend tokens.
  -h, --help  Show this help.
`;

// Top-level subcommands that `ruse <TAB>` should offer, paired with a short
// description shells can render alongside each candidate. Kept next to HELP
// so they stay in sync when new commands are added. Order is display order.
const SUBCOMMANDS = [
  ['run', 'Run a recipe (deterministic + LLM steps).'],
  ['init', 'Scaffold a .ruse/ folder (or --global to seed user recipes).'],
  ['recipes', 'List recipes, or `new`/`explain` to author/understand via agent.'],
  ['edit', 'Open the global ruse dir in your editor.'],
  ['update', 'Check GitHub and (re)install ruse.'],
  ['config', 'Get and set ruse configuration variables.'],
  ['completion', 'Print a shell completion script.'],
  ['help', 'Show help.'],
];

// Subcommands of `ruse config`, paired with descriptions for completion UIs.
const CONFIG_SUBCOMMANDS = [
  ['list', 'List variables (project > user > global).'],
  ['define', 'Set a variable (default scope: project).'],
];

// Flags each subcommand accepts, with descriptions for `_describe`-style
// completion UIs. Kept in one place so bash/zsh/fish all see the same set.
const FLAGS = {
  run: [['--dry-run', 'Skip LLM calls; print steps that would spend tokens.']],
  init: [['--global', 'Seed bundled recipes into the user-level recipes dir.']],
  update: [
    ['--check', "Report if an update is available; don't install."],
    ['--dev', 'Track the main branch instead of the latest release.'],
    ['--npm', 'Install with npm.'],
    ['--pnpm', 'Install with pnpm (default).'],
    ['--yarn', 'Install with yarn.'],
  ],
  config: [['--scope', 'Scope to act on: project, user, or global.']],
  recipes: [],
  edit: [],
  completion: [],
  help: [],
};

// Shells accepted by `ruse completion <shell>`, with descriptions.
const COMPLETION_SHELLS = [
  ['bash', 'Print bash completion script.'],
  ['zsh', 'Print zsh completion script.'],
  ['fish', 'Print fish completion script.'],
];

// Top-level flags valid before any subcommand.
const TOP_LEVEL_FLAGS = [
  ['--help', 'Show help.'],
  ['-h', 'Show help.'],
  ['--version', 'Print version.'],
  ['-v', 'Print version.'],
];

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === '--version' || cmd === '-v') {
    maybePrintBanner();
    process.stdout.write(`ruse v${readVersion()}\n`);
    return;
  }
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    maybePrintBanner();
    process.stdout.write(HELP);
    return;
  }
  if (cmd === 'init') {
    if (rest.includes('--global')) {
      await initGlobal(userRecipesDir());
      return;
    }
    const dir = rest.find((a) => !a.startsWith('-'));
    await init(dir ? resolve(process.cwd(), dir) : process.cwd());
    return;
  }
  if (cmd === 'recipes') {
    // Bare `ruse recipes` still lists what's visible. `ruse recipes new` and
    // `ruse recipes explain` hand off to the packaged Claude Code subagents so
    // end users can author/understand recipes without cloning the ruse repo.
    // `ruse recipes --help` (or -h/help) prints the subcommand help.
    if (rest.includes('-h') || rest.includes('--help') || rest[0] === 'help') {
      await runRecipesSub(undefined, userRecipesDir());
      return;
    }
    const sub = rest.find((a) => !a.startsWith('-'));
    if (!sub) {
      printRecipes(process.cwd());
      return;
    }
    await runRecipesSub(sub, userRecipesDir());
    return;
  }
  if (cmd === 'edit') {
    editGlobalDir();
    return;
  }
  if (cmd === 'update') {
    await update(rest);
    return;
  }
  if (cmd === 'config') {
    await runConfig(rest);
    return;
  }
  if (cmd === 'completion') {
    const shell = rest.find((a) => !a.startsWith('-'));
    printCompletion(shell);
    return;
  }
  if (cmd === '__complete') {
    // Hidden hook the shell completion scripts call back into. Emits one
    // candidate per line as "<value>\t<description>"; shells that don't want
    // the description simply split on \t. Keeping the candidate list in Node
    // means bash/zsh/fish stay tiny and never duplicate the flag surface.
    const [target = '', partial = ''] = rest;
    const emit = (pairs) => {
      for (const [value, desc = ''] of pairs) {
        if (value.startsWith(partial)) {
          process.stdout.write(desc ? `${value}\t${desc}\n` : `${value}\n`);
        }
      }
    };
    if (target === '' || target === 'subcommands') {
      emit(SUBCOMMANDS);
    } else if (target === 'top-flags') {
      emit(TOP_LEVEL_FLAGS);
    } else if (target === 'run') {
      // Recipe names have no useful "description" beyond their scope; include
      // it so the completion UI can hint project vs global at a glance.
      const pairs = listAllRecipes(process.cwd()).map((r) => [r.name, r.scope]);
      emit(pairs);
    } else if (target === 'completion') {
      emit(COMPLETION_SHELLS);
    } else if (target === 'config') {
      emit(CONFIG_SUBCOMMANDS);
    } else if (target === 'recipes') {
      // Nested subcommands under `ruse recipes` — offered as candidates when
      // the user has typed `ruse recipes <TAB>`.
      emit(recipesSubcommands());
    } else if (target === 'flags' || target.startsWith('flags:')) {
      // `flags:<sub>` — flags valid for that subcommand. Bare `flags` is a
      // safe fallback that returns nothing rather than erroring.
      const sub = target.startsWith('flags:') ? target.slice(6) : '';
      emit(FLAGS[sub] || []);
    }
    return;
  }
  if (cmd !== 'run') {
    console.error(`Unknown command "${cmd}". Try: ruse run <recipe>`);
    process.exitCode = 1;
    return;
  }

  const sep = rest.indexOf('--');
  const flags = sep === -1 ? rest : rest.slice(0, sep);
  const passthrough = sep === -1 ? [] : rest.slice(sep + 1);

  const dryRun = flags.includes('--dry-run');
  const recipeArg = flags.find((a) => !a.startsWith('-'));
  if (!recipeArg) {
    console.error('No recipe given. Try: ruse run <recipe>  (name or path)');
    process.exitCode = 1;
    return;
  }

  const resolved = resolveRecipe(recipeArg, process.cwd());
  if (!resolved.ok) {
    console.error(resolved.message);
    process.exitCode = 1;
    return;
  }
  const recipePath = resolved.path;
  const mod = await import(pathToFileURL(recipePath).href);
  const fn = mod.default;
  if (typeof fn !== 'function') {
    console.error(`${recipeArg} must default-export an async recipe function.`);
    process.exitCode = 1;
    return;
  }

  const ledger = new Ledger();
  const kit = makeKit({
    recipeDir: dirname(recipePath),
    state: {},
    args: passthrough,
    ledger,
    dryRun,
    log: (m) => process.stderr.write(m + '\n'),
  });

  const started = Date.now();
  await fn(kit);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  process.stderr.write(`\n✓ done in ${secs}s — ${ledger.summary()}\n`);
}

/**
 * Resolve a recipe argument to an absolute file path.
 *
 * Order (project always shadows global):
 *   1. Literal file path (absolute or relative to cwd) — preserves prior behavior.
 *   2. <nearest .ruse/>/<arg>.recipe.mjs                    [project]
 *   3. <nearest .ruse/>/<arg>.mjs                           [project]
 *   4. <user-recipes>/<arg>.recipe.mjs                      [global]
 *   5. <user-recipes>/<arg>.mjs                             [global]
 *
 * "Nearest .ruse/" is the first .ruse folder found by walking up from `cwd`.
 * <user-recipes> is $RUSE_HOME/recipes (if RUSE_HOME is set), else
 * $XDG_CONFIG_HOME/ruse/recipes, else ~/.config/ruse/recipes. The dir is
 * created lazily elsewhere — resolution never mkdirs.
 *
 * Returns { ok: true, path } on success or { ok: false, message } on failure
 * (message lists what was tried and any recipes found in either scope).
 */
export function resolveRecipe(arg, cwd) {
  const tried = [];

  // 1. Literal file path — matches old behavior exactly. Only consider it a
  // "path" if the arg contains a separator, ends in .mjs, or is absolute; a
  // bare "foo" should not accidentally resolve against cwd.
  const looksLikePath =
    isAbsolute(arg) || arg.includes('/') || arg.includes(sep) || arg.endsWith('.mjs');
  if (looksLikePath) {
    const literal = isAbsolute(arg) ? arg : resolve(cwd, arg);
    tried.push(literal);
    if (isFile(literal)) return { ok: true, path: literal };
  }

  // 2 & 3. Project scope — nearest .ruse/ walking up from cwd.
  const ruseDir = findNearestRuseDir(cwd);
  if (ruseDir) {
    for (const c of [
      join(ruseDir, `${arg}.recipe.mjs`),
      join(ruseDir, `${arg}.mjs`),
    ]) {
      tried.push(c);
      if (isFile(c)) return { ok: true, path: c };
    }
  }

  // 4 & 5. Global scope — user-level recipes dir.
  const userDir = userRecipesDir();
  for (const c of [
    join(userDir, `${arg}.recipe.mjs`),
    join(userDir, `${arg}.mjs`),
  ]) {
    tried.push(c);
    if (isFile(c)) return { ok: true, path: c };
  }

  // Build a helpful error listing what was tried and what recipes DO exist,
  // in either scope, so the user can spot typos vs missing files quickly.
  const lines = [`No recipe found for "${arg}". Tried:`];
  for (const t of tried) lines.push(`  - ${t}`);
  const all = listAllRecipes(cwd);
  if (all.length) {
    lines.push(`\nAvailable recipes:`);
    for (const r of all) lines.push(`  - ${r.name} [${r.scope}]`);
  } else {
    lines.push(`\nNo recipes found in project (.ruse/) or global (${userDir}).`);
  }
  return { ok: false, message: lines.join('\n') };
}

/**
 * Return every recipe visible from `cwd`, project first, then global.
 * Global recipes shadowed by a project recipe of the same name are omitted
 * so what you see matches what `ruse run` would resolve.
 */
export function listAllRecipes(cwd) {
  const out = [];
  const seen = new Set();

  const ruseDir = findNearestRuseDir(cwd);
  if (ruseDir) {
    for (const name of listRecipes(ruseDir)) {
      seen.add(name);
      out.push({ name, path: preferredPath(ruseDir, name), scope: 'project' });
    }
  }
  const userDir = userRecipesDir();
  for (const name of listRecipes(userDir)) {
    if (seen.has(name)) continue; // project shadows global
    out.push({ name, path: preferredPath(userDir, name), scope: 'global' });
  }
  return out;
}

/**
 * The user-scope recipes directory. Honors RUSE_HOME (points at the whole
 * ruse config dir; recipes live at $RUSE_HOME/recipes), then XDG_CONFIG_HOME,
 * then ~/.config/ruse/recipes. Never touches disk.
 */
export function userRecipesDir() {
  if (process.env.RUSE_HOME) return join(process.env.RUSE_HOME, 'recipes');
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'ruse', 'recipes');
  return join(homedir(), '.config', 'ruse', 'recipes');
}

// Pick the file we'd actually resolve for a given recipe name in a dir:
// .recipe.mjs wins over .mjs, matching resolveRecipe's order.
function preferredPath(dir, name) {
  const a = join(dir, `${name}.recipe.mjs`);
  if (isFile(a)) return a;
  return join(dir, `${name}.mjs`);
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function findNearestRuseDir(startDir) {
  let dir = startDir;
  // Bail after we hit the filesystem root (parent === self).
  while (true) {
    const candidate = join(dir, '.ruse');
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch {
      // not there, keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// List recipe short-names in a directory. Includes both <name>.recipe.mjs
// (preferred) and bare <name>.mjs since resolveRecipe accepts either. Missing
// dir returns []; the global dir is created lazily so absence is expected.
function listRecipes(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const names = new Set();
  for (const entry of entries) {
    if (entry.endsWith('.recipe.mjs')) {
      names.add(basename(entry, '.recipe.mjs'));
    } else if (entry.endsWith('.mjs')) {
      names.add(basename(entry, '.mjs'));
    }
  }
  return [...names].sort();
}

// `ruse recipes` — two-column listing, project first, then global.
// This is what the completion script and humans both call.
function printRecipes(cwd) {
  const all = listAllRecipes(cwd);
  if (!all.length) {
    process.stdout.write(
      `No recipes found. Project scope: no .ruse/ folder above ${cwd}. ` +
        `Global scope: ${userRecipesDir()} is empty or missing.\n`,
    );
    return;
  }
  // Group by scope so the header is obvious. Width from longest name so the
  // path column lines up without pulling in a formatter.
  const width = Math.max(...all.map((r) => r.name.length));
  const project = all.filter((r) => r.scope === 'project');
  const global = all.filter((r) => r.scope === 'global');
  if (project.length) {
    process.stdout.write('project:\n');
    for (const r of project) {
      process.stdout.write(`  ${r.name.padEnd(width)}  ${r.path}\n`);
    }
  }
  if (global.length) {
    if (project.length) process.stdout.write('\n');
    process.stdout.write('global:\n');
    for (const r of global) {
      process.stdout.write(`  ${r.name.padEnd(width)}  ${r.path}\n`);
    }
  }
}

/**
 * Dispatch `ruse config <subcommand>`. Kept in one place so the free/LLM
 * boundary stays visible from cli.mjs — config is deterministic and cheap;
 * no LLM here. The three scopes and their precedence live in config.mjs.
 */
async function runConfig(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '-h' || sub === '--help') {
    process.stdout.write(CONFIG_HELP);
    return;
  }
  if (sub === 'list') return runConfigList(rest);
  if (sub === 'define') return runConfigDefine(rest);
  console.error(`Unknown "ruse config" subcommand "${sub}". Try: list, define.`);
  process.exitCode = 1;
}

const CONFIG_HELP = `ruse config — manage user-defined variables

Usage:
  ruse config list [--scope project|user|global]
  ruse config define <name> <value> [--scope project|user|global]

Scopes (precedence for reads: project > user > global):
  project   <nearest .ruse/>/config.json         (checked in with the repo)
  user      <user-config>/config.json            (per-user, per-machine)
  global    <user-config>/global.config.json     (per-user, portable)

<user-config> is $RUSE_HOME, else $XDG_CONFIG_HOME/ruse, else ~/.config/ruse.

Values are parsed as JSON when possible so "42", "true", '[1,2]' round-trip
as their real types; anything that isn't valid JSON is stored as a string.

  ruse config define api_url https://example.com          # string
  ruse config define retries 3                             # number
  ruse config define models '["haiku","sonnet"]'           # array
  ruse config define --scope user default_model haiku
`;

// `ruse config list` — merged view by default; --scope narrows to one file.
function runConfigList(argv) {
  const scope = parseScope(argv, null);
  const cwd = process.cwd();

  if (scope) {
    const path = configPath(scope, cwd);
    if (!path) {
      process.stdout.write(`(no ${scope} scope available: no .ruse/ found above ${cwd})\n`);
      return;
    }
    // Load through listAllWithShadows so entries all use the same shape,
    // then filter to just this scope's rows.
    const rows = listAllWithShadows(cwd).flatMap((e) => {
      const all = [e, ...(e.shadows ?? [])];
      return all.filter((r) => r.scope === scope).map((r) => ({ ...r, shadows: [] }));
    });
    if (!rows.length) {
      process.stdout.write(`(no variables in ${scope}: ${path})\n`);
      return;
    }
    process.stdout.write(`${scope}: ${path}\n`);
    printVarRows(rows.sort((a, b) => a.name.localeCompare(b.name)));
    return;
  }

  const rows = listAllWithShadows(cwd);
  if (!rows.length) {
    process.stdout.write('No variables defined. Try: ruse config define <name> <value>\n');
    return;
  }
  // Group by winning scope so the reader can see who owns what.
  const byScope = { project: [], user: [], global: [] };
  for (const r of rows) byScope[r.scope].push(r);
  const paths = {
    project: configPath('project', cwd),
    user: configPath('user', cwd),
    global: configPath('global', cwd),
  };
  let first = true;
  for (const s of ['project', 'user', 'global']) {
    if (!byScope[s].length) continue;
    if (!first) process.stdout.write('\n');
    first = false;
    process.stdout.write(`${s}: ${paths[s] ?? '(unavailable)'}\n`);
    printVarRows(byScope[s]);
  }
}

// Shared row printer: value column, then shadow markers so the user can
// tell when a lower-precedence scope also defines a name.
function printVarRows(rows) {
  const width = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    let line = `  ${r.name.padEnd(width)}  ${formatValue(r.value)}`;
    if (r.shadows?.length) {
      const shadowed = r.shadows.map((s) => s.scope).join(', ');
      line += `   (also in: ${shadowed})`;
    }
    process.stdout.write(line + '\n');
  }
}

// `ruse config define <name> <value> [--scope ...]`
function runConfigDefine(argv) {
  const scope = parseScope(argv, 'project');
  const positional = argv.filter((a, i) => {
    if (a === '--scope') return false;
    if (i > 0 && argv[i - 1] === '--scope') return false;
    if (a.startsWith('--scope=')) return false;
    return !a.startsWith('-');
  });
  const [name, ...valueParts] = positional;
  if (!name || valueParts.length === 0) {
    console.error('Usage: ruse config define <name> <value> [--scope project|user|global]');
    process.exitCode = 1;
    return;
  }
  // Join remaining positionals so `ruse config define greeting hello world`
  // does the intuitive thing rather than silently dropping "world".
  const rawValue = valueParts.join(' ');
  const value = parseValueArg(rawValue);
  try {
    const { path, previous } = defineVariable(name, value, scope, process.cwd());
    const verb = previous === undefined ? 'defined' : 'updated';
    process.stdout.write(`${verb} ${name} = ${formatValue(value)} [${scope}]\n  ${path}\n`);
    if (previous !== undefined) {
      process.stdout.write(`  previous: ${formatValue(previous)}\n`);
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

// Parse --scope out of an argv slice. Accepts both `--scope user` and
// `--scope=user`. Returns `fallback` when absent; throws (via process.exit)
// on an unknown value so typos don't silently write to the wrong file.
function parseScope(argv, fallback) {
  let scope = fallback;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--scope') {
      scope = argv[i + 1];
      i++;
    } else if (a.startsWith('--scope=')) {
      scope = a.slice('--scope='.length);
    }
  }
  if (scope != null && !SCOPES.includes(scope)) {
    console.error(`Unknown scope "${scope}". Use one of: ${SCOPES.join(', ')}.`);
    process.exit(1);
  }
  return scope;
}

// `ruse edit` — open the global recipes dir in whatever editor the user has
// configured. Creates the dir if missing (same `mkdir -p` semantics as the
// recipes subcommands) so a fresh install can still `ruse edit` its way to
// somewhere useful. Exits non-zero when no editor can be found; unlike the
// post-authoring prompt, this command has no fallback behavior worth having.
function editGlobalDir() {
  const dir = userRecipesDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    process.stderr.write(`Failed to create ${dir}: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  const ed = openInEditor(dir);
  if (!ed) {
    process.stderr.write(
      `No editor found. Set $EDITOR or install one of: ${editorCandidatesHint()}.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Opening ${dir} with ${ed.cmd}\n`);
}

// Shell completion scripts. Handwritten — the tool is small, a framework would
// weigh more than the whole CLI. Each script calls back into `ruse __complete`
// so the candidate list stays in one place (Node), not duplicated in shell.
function printCompletion(shell) {
  if (!shell || !['bash', 'zsh', 'fish'].includes(shell)) {
    console.error(
      `Usage: ruse completion <bash|zsh|fish>\n` +
        `  bash: source <(ruse completion bash)\n` +
        `  zsh:  ruse completion zsh > "\${fpath[1]}/_ruse"\n` +
        `  fish: ruse completion fish > ~/.config/fish/completions/ruse.fish`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(COMPLETIONS[shell]);
}

const COMPLETIONS = {
  // Bash: single dispatch function. All candidate lists come from
  // `ruse __complete`; we strip the tab-separated description column here
  // because bash's `compgen -W` only wants raw words. Recipe names, flags,
  // and subcommands share one code path.
  bash: `# ruse bash completion. Install:  source <(ruse completion bash)
_ruse() {
  local cur prev words cword
  _init_completion 2>/dev/null || {
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    words=("\${COMP_WORDS[@]}")
    cword=$COMP_CWORD
  }

  # Locate the subcommand (first non-flag word after "ruse").
  local i sub=""
  for (( i=1; i<cword; i++ )); do
    case "\${words[i]}" in
      -*) ;;
      *) sub="\${words[i]}"; break ;;
    esac
  done

  # Ask ruse for candidates in the current context, then strip the description
  # column (everything after the first tab) — bash doesn't display them.
  local target=""
  if [ -z "$sub" ]; then
    # No subcommand yet. Offer subcommands (or top-level flags for a lone "-").
    case "$cur" in
      -*) target="top-flags" ;;
      *)  target="subcommands" ;;
    esac
  else
    case "$cur" in
      -*) target="flags:$sub" ;;
      *)
        case "$sub" in
          run)        target="run" ;;
          completion) target="completion" ;;
          recipes)    target="recipes" ;;
          *)          target="" ;;
        esac
        ;;
    esac
  fi

  local raw
  if [ -n "$target" ]; then
    raw="$(ruse __complete "$target" "$cur" 2>/dev/null | cut -f1)"
    COMPREPLY=( $(compgen -W "$raw" -- "$cur") )
  fi
  if [ "$sub" = "config" ] && [ "$cword" -eq 2 ]; then
    COMPREPLY=( $(compgen -W "$(ruse __complete config "$cur" 2>/dev/null)" -- "$cur") )
    return
  fi
}
complete -F _ruse ruse
`,

  // Zsh: native _arguments-driven completion. Each subcommand gets its own
  // dispatch clause so `--dry-run<TAB>` after `ruse run` completes only the
  // flags that command actually accepts, and recipe names are annotated with
  // their scope. Candidate lines are "value\tdescription", exactly what
  // _describe -V wants after we split on \t.
  zsh: `#compdef ruse
# ruse zsh completion. Install:
#   ruse completion zsh > "\${fpath[1]}/_ruse"
# then start a new shell (or run \`compinit\`).

# Turn "value\\tdescription" lines from \`ruse __complete\` into an array
# _describe can render. Each element is "value:description" (colons in the
# description are escaped so _describe doesn't get confused).
_ruse_candidates() {
  local target="$1" partial="$2" line value desc
  local -a items
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    value="\${line%%$'\\t'*}"
    if [[ "$line" == *$'\\t'* ]]; then
      desc="\${line#*$'\\t'}"
      desc="\${desc//:/\\\\:}"
      items+=("$value:$desc")
    else
      items+=("$value")
    fi
  done < <(ruse __complete "$target" "$partial" 2>/dev/null)
  _describe -V -t "$target" "$target" items
}

_ruse() {
  local curcontext="$curcontext" state line
  typeset -A opt_args

  _arguments -C \\
    '(- *)'{-h,--help}'[Show help]' \\
    '(- *)'{-v,--version}'[Print version]' \\
    '1: :->cmd' \\
    '*::arg:->args'

  case $state in
    cmd)
      _ruse_candidates subcommands "\${words[CURRENT]}"
      ;;
    args)
      local sub="\${words[1]}"
      case "$sub" in
        run)
          _arguments \\
            '--dry-run[Skip LLM calls; print steps that would spend tokens]' \\
            '(-)--[End of options; remaining args are passed to the recipe]' \\
            '*:recipe:->recipe'
          if [[ "$state" == "recipe" ]]; then
            _ruse_candidates run "\${words[CURRENT]}"
          fi
          ;;
        init)
          _arguments \\
            '--global[Seed bundled recipes into the user-level recipes dir]' \\
            '*:dir:_files -/'
          ;;
        update)
          _arguments \\
            '--check[Report if an update is available; do not install]' \\
            '--dev[Track the main branch instead of the latest release]' \\
            '(--npm --pnpm --yarn)--npm[Install with npm]' \\
            '(--npm --pnpm --yarn)--pnpm[Install with pnpm (default)]' \\
            '(--npm --pnpm --yarn)--yarn[Install with yarn]'
          ;;
        config)
          if (( CURRENT == 2 )); then
            _ruse_candidates config "\${words[CURRENT]}"
          else
            _arguments '--scope[Scope to act on: project, user, or global]'
          fi
          ;;
        completion)
          _ruse_candidates completion "\${words[CURRENT]}"
          ;;
        recipes)
          _ruse_candidates recipes "\${words[CURRENT]}"
          ;;
        edit)
          # \`ruse edit\` takes no args or flags — nothing to complete.
          ;;
        help)
          ;;
      esac
      ;;
  esac
}

_ruse "$@"
`,

  // Fish: one `complete` line per (subcommand, flag/positional). Fish shows
  // the description column natively, so we split the `__complete` output on
  // tabs and feed each side into `-a` / `-d`.
  fish: `# ruse fish completion. Install:
#   ruse completion fish > ~/.config/fish/completions/ruse.fish

# Emit fish-style "value\\tdescription" candidate lists by relaying whatever
# \`ruse __complete\` produces (its output format already matches).
function __ruse_complete
  ruse __complete $argv[1] (commandline -ct) 2>/dev/null
end

# Disable file completion by default — subcommands and flags supply their own.
complete -c ruse -f

# Top-level: subcommands only before one is given.
complete -c ruse -n '__fish_use_subcommand' -a '(__ruse_complete subcommands)'

# Top-level flags (valid before any subcommand).
complete -c ruse -n '__fish_use_subcommand' -s h -l help    -d 'Show help'
complete -c ruse -n '__fish_use_subcommand' -s v -l version -d 'Print version'

# ruse run <recipe> [--dry-run]
complete -c ruse -n '__fish_seen_subcommand_from run' -a '(__ruse_complete run)'
complete -c ruse -n '__fish_seen_subcommand_from run' -l dry-run \\
  -d 'Skip LLM calls; print steps that would spend tokens'

# ruse init [--global] [dir]
complete -c ruse -n '__fish_seen_subcommand_from init' -l global \\
  -d 'Seed bundled recipes into the user-level recipes dir'
complete -c ruse -n '__fish_seen_subcommand_from init' -F

# ruse update [flags]
complete -c ruse -n '__fish_seen_subcommand_from update' -l check \\
  -d 'Report if an update is available; do not install'
complete -c ruse -n '__fish_seen_subcommand_from update' -l dev \\
  -d 'Track the main branch instead of the latest release'
complete -c ruse -n '__fish_seen_subcommand_from update' -l npm  -d 'Install with npm'
complete -c ruse -n '__fish_seen_subcommand_from update' -l pnpm -d 'Install with pnpm (default)'
complete -c ruse -n '__fish_seen_subcommand_from update' -l yarn -d 'Install with yarn'

# ruse config <list|define> [--scope <s>]
complete -c ruse -n '__fish_seen_subcommand_from config' \\
  -a '(__ruse_complete config)'
complete -c ruse -n '__fish_seen_subcommand_from config' -l scope \\
  -d 'Scope to act on: project, user, or global'

# ruse completion <bash|zsh|fish>
complete -c ruse -n '__fish_seen_subcommand_from completion' \\
  -a '(__ruse_complete completion)'

# ruse recipes [new|explain]
complete -c ruse -n '__fish_seen_subcommand_from recipes' \\
  -a '(__ruse_complete recipes)'

# ruse edit — no args or flags, but the top-level \`complete -f\` above already
# disables file completion, so nothing else is needed here.
`,
};

main(process.argv.slice(2)).catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
});
