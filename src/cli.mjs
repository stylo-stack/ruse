#!/usr/bin/env node
// `ruse` — run a recipe that interleaves deterministic scripts with LLM prompts.

import { resolve, dirname, join, basename, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { makeKit, Ledger } from './runtime.mjs';
import { init, initGlobal } from './init.mjs';

const HELP = `ruse — rational use of LLMs

Usage:
  ruse init [dir]                        Scaffold a .ruse/ folder in a project.
  ruse init --global                     Seed global recipes into <user-recipes>.
  ruse run <recipe> [--dry-run] [-- ...args]
  ruse recipes                           List every recipe visible from cwd.
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

// Top-level subcommands that `ruse <TAB>` should offer. Kept next to HELP so
// they stay in sync when new commands are added.
const SUBCOMMANDS = ['run', 'init', 'recipes', 'completion', 'help'];

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
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
    printRecipes(process.cwd());
    return;
  }
  if (cmd === 'completion') {
    const shell = rest.find((a) => !a.startsWith('-'));
    printCompletion(shell);
    return;
  }
  if (cmd === '__complete') {
    // Hidden hook the shell completion scripts call back into. Prints one
    // candidate per line so shells can read it cheaply. Kept intentionally
    // minimal — extend later if new subcommands sprout their own completions.
    const [target, partial = ''] = rest;
    if (target === 'run') {
      for (const r of listAllRecipes(process.cwd())) {
        if (r.name.startsWith(partial)) process.stdout.write(r.name + '\n');
      }
    } else if (!target) {
      for (const s of SUBCOMMANDS) {
        if (s.startsWith(partial)) process.stdout.write(s + '\n');
      }
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
  bash: `# ruse bash completion. Install:  source <(ruse completion bash)
_ruse() {
  local cur prev words cword
  _init_completion 2>/dev/null || {
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    words=("\${COMP_WORDS[@]}")
    cword=$COMP_CWORD
  }
  local sub="\${words[1]}"
  if [ "$cword" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$(ruse __complete '' "$cur" 2>/dev/null)" -- "$cur") )
    return
  fi
  if [ "$sub" = "run" ] && [ "$cword" -eq 2 ]; then
    COMPREPLY=( $(compgen -W "$(ruse __complete run "$cur" 2>/dev/null)" -- "$cur") )
    return
  fi
}
complete -F _ruse ruse
`,
  zsh: `#compdef ruse
# ruse zsh completion. Install:  ruse completion zsh > "\${fpath[1]}/_ruse"
_ruse() {
  local -a candidates
  if (( CURRENT == 2 )); then
    candidates=( \${(f)"$(ruse __complete '' "\${words[2]}" 2>/dev/null)"} )
    compadd -a candidates
    return
  fi
  if [[ "\${words[2]}" == "run" ]] && (( CURRENT == 3 )); then
    candidates=( \${(f)"$(ruse __complete run "\${words[3]}" 2>/dev/null)"} )
    compadd -a candidates
    return
  fi
}
_ruse "$@"
`,
  fish: `# ruse fish completion. Install:  ruse completion fish > ~/.config/fish/completions/ruse.fish
function __ruse_subs
  ruse __complete '' (commandline -ct) 2>/dev/null
end
function __ruse_recipes
  ruse __complete run (commandline -ct) 2>/dev/null
end
complete -c ruse -f
complete -c ruse -n '__fish_use_subcommand' -a '(__ruse_subs)'
complete -c ruse -n '__fish_seen_subcommand_from run' -a '(__ruse_recipes)'
`,
};

main(process.argv.slice(2)).catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
});
