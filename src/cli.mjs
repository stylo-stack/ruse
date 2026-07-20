#!/usr/bin/env node
// `ruse` — run a recipe that interleaves deterministic scripts with LLM prompts.

import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeKit, Ledger } from './runtime.mjs';
import { init } from './init.mjs';

const HELP = `ruse — rational use of LLMs

Usage:
  ruse init [dir]                        Scaffold a .ruse/ folder in a project.
  ruse run <recipe.mjs> [--dry-run] [-- ...args]

A recipe is a JS module whose default export is an async function:

  export default async function ({ ask, run, sh, prompt, agent, handoff, state }) {
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

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }
  if (cmd === 'init') {
    const dir = rest.find((a) => !a.startsWith('-'));
    await init(dir ? resolve(process.cwd(), dir) : process.cwd());
    return;
  }
  if (cmd !== 'run') {
    console.error(`Unknown command "${cmd}". Try: ruse run <recipe.mjs>`);
    process.exitCode = 1;
    return;
  }

  const sep = rest.indexOf('--');
  const flags = sep === -1 ? rest : rest.slice(0, sep);
  const passthrough = sep === -1 ? [] : rest.slice(sep + 1);

  const dryRun = flags.includes('--dry-run');
  const recipeArg = flags.find((a) => !a.startsWith('-'));
  if (!recipeArg) {
    console.error('No recipe file given. Try: ruse run <recipe.mjs>');
    process.exitCode = 1;
    return;
  }

  const recipePath = resolve(process.cwd(), recipeArg);
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

main(process.argv.slice(2)).catch((err) => {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
});
