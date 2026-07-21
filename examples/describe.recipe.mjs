// Example recipe: build shared LLM context once, then reuse it across
// multiple downstream prompts. Two `context()` calls (structured, cached in
// state.context) feed two follow-up `prompt()` calls that share the same
// context blocks — so the cache-friendly prefix is byte-stable and, when
// possible, the runtime auto-threads to a shared sessionId.

export default async function ({ sh, context, prompt, state }) {
  // 1. Deterministic gathering — free.
  const listing = await sh('ls -1');
  const readme = await sh('head -n 40 README.md 2>/dev/null || echo "(no README)"');

  // 2. Two structured context builds. Each is one LLM call; results land on
  //    state.context.<name> and are reusable across every later prompt.
  await context('repoMap', 'prompts/repo_map.md', {
    model: 'haiku',
    input: listing,
    schema: {
      type: 'object',
      required: ['groups'],
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'key_file'],
            properties: { name: { type: 'string' }, key_file: { type: 'string' } },
          },
        },
      },
    },
  });

  await context('style', 'prompts/style_notes.md', {
    model: 'haiku',
    input: readme,
    schema: {
      type: 'object',
      required: ['voice', 'rules'],
      properties: {
        voice: { type: 'string' },
        rules: { type: 'array', items: { type: 'string' } },
      },
    },
  });

  // 3. Reuse. Order in `context: [...]` controls the prefix — keep it stable
  //    across calls so the server-side prefix cache can hit.
  const { text: blurb } = await prompt('prompts/blurb.md', {
    model: 'haiku',
    context: ['repoMap', 'style'],
  });
  const { text: tagline } = await prompt('prompts/tagline.md', {
    model: 'haiku',
    context: ['repoMap', 'style'],
  });

  state.output = { blurb, tagline };
  console.log(`\nTagline: ${tagline}\n\nBlurb:\n${blurb}\n`);
}
