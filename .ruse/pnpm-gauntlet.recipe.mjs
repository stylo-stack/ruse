// .ruse/pnpm-gauntlet.recipe.mjs
//
// Run a sequence of pnpm quality checks. Everything is deterministic; an LLM
// agent is only spawned when a check ACTUALLY fails, and only to fix that
// specific failure. After a fix, the check is re-run — the recipe only moves
// on when the check passes on its own.
//
// Steps (in order):
//   1. pnpm test                    — fix-agent on failure
//   2. pnpm lint                    — fix-agent on failure
//   3. pnpm translations:sort:fix   — itself a fixer, no agent needed
//   4. pnpm check-types             — fix-agent on failure
//   5. pnpm format:write            — fix-agent on failure
//
// Happy-path LLM calls: 0. Each failing check adds at most MAX_ATTEMPTS-1
// agent calls before the recipe gives up on that check.
//
// Run:  ruse run pnpm-gauntlet [--dry-run]

const MAX_ATTEMPTS = 3;

export default async function ({ sh, agent, state, log }) {
  // Deterministic: run a shell command, stream combined stdout+stderr live to
  // the user's terminal, and also capture it so a fix-agent can see it on
  // failure. No tokens spent here.
  async function runCheck(command) {
    try {
      const output = await sh(`${command} 2>&1`, { stream: true });
      return { ok: true, output };
    } catch (err) {
      return { ok: false, output: err.output ?? '', error: err.message };
    }
  }

  // Deterministic: run a check, and if it fails, hand the failure to a
  // fix-agent, then re-run. Loops up to MAX_ATTEMPTS. Only spends tokens on
  // failure. Returns when the check passes; throws if we run out of attempts.
  async function checkWithFixAgent({ label, command, kind }) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      log(`\n[${label}] running (attempt ${attempt}/${MAX_ATTEMPTS}): ${command}`);
      const { ok, output } = await runCheck(command);        // free
      if (ok) {
        log(`[${label}] passed.`);
        return;
      }
      log(`[${label}] failed. Dispatching fix-agent.`);
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(
          `[${label}] still failing after ${MAX_ATTEMPTS} attempt(s). ` +
            `Last output:\n${output}`,
        );
      }
      // LLM (token spend): focused fix-agent with the failing output as input.
      await agent('general-purpose', 'prompts/fix-check.md', {
        model: 'sonnet',
        permissionMode: 'acceptEdits',
        input: { command, kind, attempt, output },
      });
      // Loop: re-run the check to see if the fix actually worked.
    }
  }

  // Step 1 — tests. Free unless it fails.
  await checkWithFixAgent({
    label: '1/5 tests',
    command: 'pnpm test',
    kind: 'unit/integration tests',
  });

  // Step 2 — lint. Free unless it fails.
  await checkWithFixAgent({
    label: '2/5 lint',
    command: 'pnpm lint',
    kind: 'eslint / lint',
  });

  // Step 3 — translations sorter. This IS the fixer; just run it. No agent.
  // Free step (no LLM). On non-zero exit we surface the captured output via
  // `err.output` (attached by `sh` when streaming) and bail.
  log(`\n[3/5 translations] running: pnpm translations:sort:fix`);
  const sortResult = await runCheck('pnpm translations:sort:fix');
  if (!sortResult.ok) {
    throw new Error(
      `[3/5 translations] pnpm translations:sort:fix failed:\n${sortResult.output}`,
    );
  }
  log(`[3/5 translations] done.`);

  // Step 4 — type check. Free unless it fails.
  // package.json script name confirmed to be `check-types` (per project convention);
  // if the project happens to expose it as `type-check` etc., adjust here.
  await checkWithFixAgent({
    label: '4/5 check-types',
    command: 'pnpm check-types',
    kind: 'typescript type-check',
  });

  // Step 5 — formatter (write mode). This normally just rewrites files, but
  // if it exits non-zero (parse error, etc.), a fix-agent gets a shot.
  await checkWithFixAgent({
    label: '5/5 format',
    command: 'pnpm format:write',
    kind: 'prettier / formatter (write mode)',
  });

  state.completed = true;
  log(`\nAll 5 checks passed.`);
}
