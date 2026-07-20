// .ruse/define.recipe.mjs
//
// Ask for a word, get a definition. One deterministic prompt, one LLM call.
// Run:  ruse run define

export default async function ({ ask, prompt }) {
  const word = (await ask('Word to define?')).trim();
  if (!word) {
    console.log('No word given.');
    return;
  }

  const { text } = await prompt(
    `Define "${word}" in 2-3 sentences. Include the part of speech and one example sentence. Plain text, no markdown.`,
    { model: 'haiku' },
  );

  console.log(`\n${word}\n${'-'.repeat(word.length)}\n${text.trim()}`);
}
