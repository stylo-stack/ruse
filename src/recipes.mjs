// `ruse recipes new | explain` — thin launchers that hand a real, interactive
// Claude Code session to one of the two user-facing subagents shipped with
// ruse. These commands exist so end users can author and understand recipes
// without cloning the ruse repo (the agents would otherwise live in
// `.claude/agents/` inside the checkout).
//
// Both commands operate at the GLOBAL level: files land in the user-scope
// recipes dir (see cli.mjs → userRecipesDir), never in a project-local
// `.ruse/`. That is the whole point — a user in any working directory can
// author recipes that are runnable from anywhere.
//
// The `ruse-dev` agent is intentionally NOT wired here; it targets the ruse
// tool itself and doesn't belong in the end-user surface.

import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  snapshotDir,
  snapshotsDiffer,
  confirm,
  openInEditor,
  editorCandidatesHint,
} from './editor.mjs';

// Agents we expose to end users. Kept as a small allowlist so `ruse recipes
// <sub>` can't be pointed at arbitrary agent files, and so the help text
// stays in sync with what actually dispatches.
const AGENTS = {
  new: {
    agent: 'recipe-author',
    file: 'recipe-author.md',
    summary: 'Author a new recipe (writes files into the global ruse dir).',
    // Read/Write/Edit/Glob/Grep/Bash/AskUserQuestion mirrors the tools listed
    // in recipe-author's frontmatter. Passed via --allowedTools so the agent
    // can actually create the recipe + helpers, even if the user's global
    // settings default to a stricter allowlist.
    allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'AskUserQuestion'],
    // acceptEdits skips the per-write confirmation prompt; the whole point of
    // this command is that the agent WRITES the recipe. Users who want a
    // stricter dance can invoke claude directly.
    permissionMode: 'acceptEdits',
  },
  explain: {
    agent: 'recipe-guide',
    file: 'recipe-guide.md',
    summary: 'Explain the kit API, patterns, and the minimize-LLM-use philosophy.',
    // recipe-guide is deliberately read-only; only Read/Grep/Glob per its
    // frontmatter. No permissionMode override needed — nothing writes.
    allowedTools: ['Read', 'Grep', 'Glob'],
  },
};

const HELP = `ruse recipes — list, author, and understand recipes

Usage:
  ruse recipes                 List every recipe visible from cwd.
  ruse recipes new             Author a new recipe via the recipe-author agent.
                               Writes into the GLOBAL ruse dir (never a
                               project-local .ruse/).
  ruse recipes explain         Ask the recipe-guide agent how the kit works,
                               patterns, or why a recipe misbehaves. Read-only.

Both subcommands launch an interactive Claude Code session using the agent
shipped with ruse. They require the \`claude\` CLI to be installed and on PATH.

After \`ruse recipes new\`, if the agent actually created or modified any files
in the global recipes dir, you will be prompted to open the dir in your editor
(\`\$VISUAL\`, \`\$EDITOR\`, or a detected IDE). Answer n to skip. Use
\`ruse edit\` at any time to open the global dir without going through the
authoring flow.
`;

/**
 * Dispatch `ruse recipes <sub>`.
 *
 * @param {string|undefined} sub  One of "new" | "explain" (or undefined/"--help").
 * @param {string} userRecipesDir Absolute path to the user-scope recipes dir.
 */
export async function runRecipesSub(sub, userRecipesDir) {
  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const spec = AGENTS[sub];
  if (!spec) {
    process.stderr.write(
      `Unknown "ruse recipes ${sub}". Known: new, explain.\n` +
        `Run \`ruse recipes --help\` for details.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Ensure the global recipes dir exists so the agent has somewhere to write.
  // Never overwrites anything — `mkdir -p` semantics.
  try {
    mkdirSync(userRecipesDir, { recursive: true });
  } catch (err) {
    process.stderr.write(`Failed to create ${userRecipesDir}: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  const agentsDir = bundledAgentsDir();
  const agentPath = join(agentsDir, spec.file);
  if (!existsSync(agentPath)) {
    process.stderr.write(
      `Could not find bundled agent at ${agentPath}.\n` +
        `This usually means the install is missing .claude/agents/; try reinstalling ruse.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const definition = loadAgentDefinition(agentPath, spec.agent);
  // Inline the agent via --agents JSON so we do NOT rely on the user having
  // a matching agent at ~/.claude/agents/ or in cwd. Fully hermetic.
  const agentsJson = JSON.stringify({ [spec.agent]: definition });

  // Extra system prompt telling the agent where "global" is. The agents ship
  // with prose about `.ruse/` which is the project-scope layout; for these
  // commands the equivalent root is <userRecipesDir> itself.
  const systemNote = buildSystemNote(sub, userRecipesDir);

  const args = [
    '--agent', spec.agent,
    '--agents', agentsJson,
    '--append-system-prompt', systemNote,
    '--add-dir', userRecipesDir,
  ];
  if (spec.permissionMode) args.push('--permission-mode', spec.permissionMode);
  if (spec.allowedTools?.length) args.push('--allowedTools', spec.allowedTools.join(' '));

  // Snapshot the global recipes dir before spawning the agent. After the
  // session exits we compare against a fresh snapshot to decide whether to
  // offer to open the dir in the user's editor — only if the agent actually
  // wrote/touched something. `explain` is read-only so we skip the snapshot
  // entirely there.
  const before = sub === 'new' ? snapshotDir(userRecipesDir) : null;

  // Set cwd to <userRecipesDir> so the agent's default file writes and its
  // Bash/Glob tool calls land in (or resolve against) the global dir — the
  // whole point of these commands. The agent's own instructions still say
  // "keep recipes in `.ruse/`"; our appended system note tells it that here,
  // cwd IS the equivalent of `.ruse/`.
  const child = spawn('claude', args, {
    cwd: userRecipesDir,
    stdio: 'inherit',
  });

  await new Promise((res, rej) => {
    child.on('error', (err) => {
      rej(new Error(`Failed to launch \`claude\`: ${err.message}. Is it installed and on PATH?`));
    });
    child.on('close', (code) => {
      if (code !== 0 && code !== null) process.exitCode = code;
      res();
    });
  });

  // Post-authoring prompt: if the agent actually changed anything in the
  // global dir, offer to open it. Skipped when nothing changed (agent bailed,
  // user aborted early, read-only session) so we don't nag. No-op for
  // `explain` since we never snapshotted.
  if (before) {
    const after = snapshotDir(userRecipesDir);
    if (snapshotsDiffer(before, after)) {
      await promptOpenAfterAuthoring(userRecipesDir);
    }
  }
}

// Optional post-authoring "open in editor?" gesture. Prints a one-line notice
// and returns silently if no editor can be found — the recipe was already
// written, this is a convenience, not a critical path.
async function promptOpenAfterAuthoring(userRecipesDir) {
  const yes = await confirm('Open the global ruse dir in your editor?', { default: 'y' });
  if (!yes) return;
  const ed = openInEditor(userRecipesDir);
  if (!ed) {
    process.stderr.write(
      `No editor found. Set $EDITOR or install one of: ${editorCandidatesHint()}.\n`,
    );
    return;
  }
  process.stdout.write(`Opening ${userRecipesDir} with ${ed.cmd}\n`);
}

// One-line summary for each subcommand, used by help/completion so the two
// lists never drift.
export function recipesSubcommands() {
  return Object.entries(AGENTS).map(([sub, spec]) => [sub, spec.summary]);
}

/**
 * Return the absolute path to the bundled `.claude/agents/` directory shipped
 * with ruse. The layout is `<install>/.claude/agents/` alongside `<install>/src/`.
 * Callers must handle the not-installed case (existsSync check at callsite).
 */
export function bundledAgentsDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '.claude', 'agents');
}

/**
 * Parse `<name>.md` (YAML-ish frontmatter + markdown body) into the shape
 * `claude --agents` wants: `{ description, prompt, tools? }`.
 *
 * We only support the exact frontmatter format ruse's own agents use:
 *   ---
 *   name: recipe-author
 *   description: ...
 *   tools: Read, Write, Edit, Grep, Glob, Bash, AskUserQuestion
 *   ---
 *   <markdown body used as the system prompt>
 *
 * A missing/unparseable frontmatter falls back to using the whole file as the
 * prompt with a generic description — safe, if less informative.
 */
function loadAgentDefinition(path, name) {
  const raw = readFileSync(path, 'utf8');
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) {
    return { description: `The ruse ${name} agent.`, prompt: raw };
  }
  const [, front, body] = m;
  const meta = {};
  for (const line of front.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    meta[kv[1].trim()] = kv[2].trim();
  }
  const def = {
    description: meta.description || `The ruse ${name} agent.`,
    prompt: body.trim(),
  };
  if (meta.tools) {
    def.tools = meta.tools.split(',').map((t) => t.trim()).filter(Boolean);
  }
  return def;
}

// System-prompt addendum per subcommand. Kept small and factual — the agent's
// own body is the interesting part; this just pins down "where global lives".
function buildSystemNote(sub, userRecipesDir) {
  if (sub === 'new') {
    return (
      `You are running under \`ruse recipes new\`.\n` +
      `Operate at the GLOBAL ruse level, not a project-local .ruse/.\n` +
      `The global recipes root is: ${userRecipesDir}\n` +
      `Your cwd is that directory, so treat cwd as the equivalent of \`.ruse/\`:\n` +
      `  - recipe files:   ${userRecipesDir}/<name>.recipe.mjs\n` +
      `  - helper scripts: ${userRecipesDir}/scripts/\n` +
      `  - prompt bodies:  ${userRecipesDir}/prompts/\n` +
      `Write files there directly. Do NOT create a \`.ruse/\` subfolder inside cwd, ` +
      `and do NOT run \`ruse init\` — the global dir already plays that role.\n` +
      `Validate with: \`ruse run <name> --dry-run\` (the global recipe resolves from anywhere).`
    );
  }
  if (sub === 'explain') {
    return (
      `You are running under \`ruse recipes explain\`.\n` +
      `You are read-only: you never write or edit files.\n` +
      `When the user asks where recipes live at the user scope, point at: ${userRecipesDir}\n` +
      `Cite files as path:line and keep answers short.`
    );
  }
  return '';
}
