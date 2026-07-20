// `ruse init` — drop a ready-to-edit .ruse/ folder into a project.
// Never overwrites existing files; reports what it created vs skipped.

import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const RECIPE = `// .ruse/example.recipe.mjs
// A recipe interleaves free deterministic steps with explicit LLM steps.
// Run:  ruse run .ruse/example.recipe.mjs [--dry-run]

export default async function ({ ask, run, sh, prompt, agent, state }) {
  // 1. Deterministic: gather context with plain commands (no tokens).
  const branch = await sh('git rev-parse --abbrev-ref HEAD || echo no-git');
  const files = await run('scripts/changed.sh');

  // 2. Ask the user something, if you need to.
  const focus = await ask('Anything to focus the review on?', { default: 'correctness' });

  // 3. LLM (opt-in): the only token spend. Structured output flows into code.
  const { data } = await prompt('prompts/review.md', {
    model: 'haiku',
    input: { branch, focus, files },
    schema: {
      type: 'object',
      required: ['summary', 'issues'],
      properties: {
        summary: { type: 'string' },
        issues: { type: 'array', items: { type: 'string' } },
      },
    },
  });

  // 4. Back to deterministic: use the structured result however you like.
  state.review = data;
  console.log('\\n' + data.summary);
  data.issues.forEach((i, n) => console.log(\`  \${n + 1}. \${i}\`));
}
`;

const SCRIPT = `#!/usr/bin/env bash
# Deterministic helper: list files changed vs the default branch. No LLM.
set -euo pipefail
base="\${1:-origin/main}"
git diff --name-only "\$base"...HEAD 2>/dev/null || git diff --name-only
`;

const PROMPT = `Review the changes described in the input.
Focus on the area named in "focus". Be specific and terse.
Return your findings in the requested JSON shape only.
`;

const GITIGNORE = `# ruse run artifacts (uncomment if your recipes write scratch files)
# scratch/
`;

const FILES = [
  ['example.recipe.mjs', RECIPE],
  ['scripts/changed.sh', SCRIPT],
  ['prompts/review.md', PROMPT],
  ['.gitignore', GITIGNORE],
];

export async function init(targetDir = process.cwd()) {
  const root = resolve(targetDir, '.ruse');
  const created = [];
  const skipped = [];

  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'prompts'), { recursive: true });

  for (const [rel, content] of FILES) {
    const dest = join(root, rel);
    if (await exists(dest)) {
      skipped.push(rel);
      continue;
    }
    await writeFile(dest, content);
    created.push(rel);
  }

  const shown = relative(process.cwd(), root) || '.ruse';
  for (const f of created) process.stdout.write(`  create  ${shown}/${f}\n`);
  for (const f of skipped) process.stdout.write(`  skip    ${shown}/${f} (exists)\n`);
  process.stdout.write(
    `\n${created.length} file(s) created. Try:\n  ruse run ${shown}/example.recipe.mjs --dry-run\n`,
  );
}

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
