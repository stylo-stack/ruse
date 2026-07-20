// Example recipe: pick a file (deterministic), read it (deterministic),
// then summarize it (ONE cheap LLM call on haiku). Everything except the
// summary runs without spending a token.

export default async function ({ ask, run, sh, prompt, state }) {
  // 1. Deterministic: enumerate candidate files, let the user choose.
  const listing = await run('scripts/list_files.sh', { args: [process.cwd(), '*.md'] });
  const files = listing.split('\n').filter(Boolean);
  if (files.length === 0) {
    console.log('No .md files here to summarize.');
    return;
  }
  const file = await ask('Which file should I summarize?', { choices: files });

  // 2. Deterministic: read the chosen file with a plain shell command.
  const text = await sh(`cat "${file}"`);
  state.file = file;

  // 3. LLM (opt-in, explicit, cheap model): the only token spend in this recipe.
  const { text: summary } = await prompt('prompts/summarize.md', {
    model: 'haiku',
    input: text,
  });

  console.log(`\nSummary of ${file}:\n${summary}`);
}
