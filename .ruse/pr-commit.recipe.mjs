// .ruse/pr-commit.recipe.mjs
//
// End-to-end: branch (if needed) → run the pnpm-gauntlet checks → commit →
// push (setting upstream on first push) → open a PR if one isn't already open.
//
// Everything except the delegated `pnpm-gauntlet` handoff is deterministic
// shell + user prompts. `pnpm-gauntlet` itself only spends tokens if a check
// fails (see that recipe for details), so the happy path is 0 LLM calls.
//
// Steps:
//   1. If on `main`, prompt for a new branch name and `git checkout -b`.
//   2. Prompt the user for a commit message.
//   3. Hand off to `pnpm-gauntlet` (test / lint / translations / types / format).
//   4. git add -A
//   5. git commit -m "<msg>"
//   6. git push (with `-u origin <branch>` if no upstream is set)
//   7. Detect an existing open PR for the branch. If none, ask whether to
//      create one and (if yes) prompt for a title.
//   8. Create PR via `gh pr create --title <title> --body ""` if requested.
//
// Run:  ruse run pr-commit [--dry-run]

export default async function ({ ask, sh, handoff, state, log }) {
  // Small helper: run a shell command with live output, capturing it so we
  // can attach it to any error we throw. Mirrors pnpm-gauntlet's runCheck.
  async function runShell(command, { stream = true } = {}) {
    try {
      const output = await sh(`${command} 2>&1`, { stream });
      return { ok: true, output };
    } catch (err) {
      return { ok: false, output: err.output ?? '', error: err.message, exitCode: err.exitCode };
    }
  }

  // ---- Step 1: branch check -------------------------------------------------
  log(`\n[1/8 branch] checking current branch`);
  const branchRes = await runShell('git rev-parse --abbrev-ref HEAD', { stream: false });
  if (!branchRes.ok) {
    throw new Error(`[1/8 branch] failed to read current branch:\n${branchRes.output}`);
  }
  let branch = branchRes.output.trim();
  log(`[1/8 branch] on "${branch}"`);

  if (branch === 'main') {
    const newBranch = (await ask('On main. Enter a new branch name to check out:')).trim();
    if (!newBranch) throw new Error(`[1/8 branch] no branch name given; aborting.`);
    const checkoutRes = await runShell(`git checkout -b ${JSON.stringify(newBranch)}`);
    if (!checkoutRes.ok) {
      throw new Error(`[1/8 branch] git checkout -b failed:\n${checkoutRes.output}`);
    }
    branch = newBranch;
    log(`[1/8 branch] now on "${branch}"`);
  }

  // ---- Step 2: commit message ---------------------------------------------
  const commitMsg = (await ask('Commit message:')).trim();
  if (!commitMsg) throw new Error(`[2/8 commit-msg] empty commit message; aborting.`);

  // ---- Step 3: pnpm-gauntlet -----------------------------------------------
  // Handoff runs the other recipe with the same kit / state; any failure
  // inside it throws and bubbles up here, which is what we want.
  log(`\n[3/8 gauntlet] handing off to pnpm-gauntlet`);
  await handoff('pnpm-gauntlet.recipe.mjs');
  log(`[3/8 gauntlet] all checks passed.`);

  // ---- Step 4: git add ------------------------------------------------------
  log(`\n[4/8 add] git add -A`);
  const addRes = await runShell('git add -A');
  if (!addRes.ok) {
    throw new Error(`[4/8 add] git add failed:\n${addRes.output}`);
  }

  // ---- Step 5: git commit ---------------------------------------------------
  // Use stdin for the commit message via `git commit -F -` so we never have to
  // shell-escape the user's text.
  log(`\n[5/8 commit] git commit`);
  const commitRes = await runShell(
    `printf '%s' ${JSON.stringify(commitMsg)} | git commit -F -`,
  );
  if (!commitRes.ok) {
    throw new Error(`[5/8 commit] git commit failed:\n${commitRes.output}`);
  }

  // ---- Step 6/7: push (setting upstream if needed) --------------------------
  log(`\n[6/8 push] checking upstream`);
  const upstreamRes = await runShell(
    'git rev-parse --abbrev-ref --symbolic-full-name @{u}',
    { stream: false },
  );
  let pushCmd;
  if (upstreamRes.ok) {
    log(`[6/8 push] upstream is "${upstreamRes.output.trim()}"`);
    pushCmd = 'git push';
  } else {
    log(`[6/8 push] no upstream set; will push with -u origin ${branch}`);
    pushCmd = `git push -u origin ${JSON.stringify(branch)}`;
  }
  const pushRes = await runShell(pushCmd);
  if (!pushRes.ok) {
    throw new Error(`[6/8 push] ${pushCmd} failed:\n${pushRes.output}`);
  }

  // ---- Step 8: PR handling --------------------------------------------------
  log(`\n[8/8 pr] checking for existing open PR on "${branch}"`);
  // `gh pr view --json` exits non-zero when no PR exists — that's the signal.
  const prViewRes = await runShell(
    `gh pr view ${JSON.stringify(branch)} --json number,url,state`,
    { stream: false },
  );

  let prCreated = false;
  let prUrl = null;

  if (prViewRes.ok) {
    // Existing PR — surface it and skip creation.
    let parsed = null;
    try { parsed = JSON.parse(prViewRes.output); } catch { /* ignore */ }
    prUrl = parsed?.url ?? null;
    log(`[8/8 pr] existing PR found${prUrl ? `: ${prUrl}` : ''}. Skipping creation.`);
  } else {
    const answer = (await ask('No open PR for this branch. Create one? [y/N]')).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') {
      const title = (await ask('PR title:')).trim();
      if (!title) throw new Error(`[8/8 pr] empty PR title; aborting.`);
      const createRes = await runShell(
        `gh pr create --title ${JSON.stringify(title)} --body ""`,
      );
      if (!createRes.ok) {
        throw new Error(`[8/8 pr] gh pr create failed:\n${createRes.output}`);
      }
      prCreated = true;
      // Grab the URL for the recap.
      const urlRes = await runShell(
        `gh pr view ${JSON.stringify(branch)} --json url -q .url`,
        { stream: false },
      );
      if (urlRes.ok) prUrl = urlRes.output.trim();
      log(`[8/8 pr] PR created${prUrl ? `: ${prUrl}` : ''}.`);
    } else {
      log(`[8/8 pr] skipping PR creation.`);
    }
  }

  state.completed = true;
  state.branch = branch;
  state.prUrl = prUrl;
  state.prCreated = prCreated;

  // Recap (same tone as pnpm-gauntlet's closing line).
  const recapLines = [
    `\nAll 8 steps done.`,
    `  branch:  ${branch}`,
    `  commit:  ${commitMsg.split('\n')[0]}`,
    `  pushed:  yes`,
  ];
  if (prUrl) recapLines.push(`  pr:      ${prUrl}${prCreated ? ' (new)' : ' (existing)'}`);
  else recapLines.push(`  pr:      none`);
  log(recapLines.join('\n'));
}
