# rational-use (`ruse`)

Orchestrate deterministic scripts and LLM prompts from a single recipe — and
**spend tokens only where judgment is actually needed.**

A *recipe* is a plain JS module that default-exports an async function. The
runtime hands it a small toolkit. Deterministic helpers (`ask`, `run`, `sh`)
are free; `prompt`/`agent` are the only calls that hit an LLM, so they stay
explicit and auditable.

```js
export default async function ({ ask, run, sh, prompt, agent, handoff, use, state }) {
  const file = await ask('Which file?', { choices: ['a.md', 'b.md'] });
  const text = await sh(`cat "${file}"`);              // deterministic
  const { text: summary } = await prompt('prompts/summarize.md', {
    model: 'haiku',                                    // per-step model choice
    input: text,
  });                                                  // <- only token spend
  console.log(summary);
}
```

## Install

Install globally to get the `ruse` command on your `PATH`:

```bash
# npm
npm install -g github:stylo-stack/ruse

# pnpm
pnpm add -g github:stylo-stack/ruse

# yarn
yarn global add github:stylo-stack/ruse
```

Then verify:

```bash
ruse --help
which ruse
```

Requires **Node.js ≥ 18**. To upgrade, either re-run the same install command
or use `ruse update` (see below). To uninstall: `npm uninstall -g rational-use`
(or `pnpm remove -g rational-use`).

### Updating

```bash
ruse update              # check GitHub Releases; if newer, prompt and install
ruse update --check      # check only, no install
ruse update --dev        # install the latest commit on main
ruse update --npm        # override the package manager (default is pnpm)
ruse update --yarn       # same, for yarn
```

`ruse update` compares your installed version against the latest GitHub
Release. `--dev` switches the source to the tip of `main` on
`stylo-stack/ruse` and remembers the installed SHA so a follow-up
`ruse update --check --dev` can tell you "already up to date". The flags
`--npm`, `--pnpm`, and `--yarn` are mutually exclusive; pnpm is the default.

<details>
<summary>Install from a local checkout</summary>

```bash
git clone https://github.com/stylo-stack/ruse.git
cd ruse
npm link          # or: pnpm link --global
```

</details>

## Run

```bash
ruse init                                        # scaffold .ruse/ into a project
ruse run summarize                               # short name — resolves .ruse/summarize.recipe.mjs
ruse run summarize --dry-run                     # skip LLM calls, show what would cost
ruse run summarize -- --arg1 value               # pass args (kit.args)
ruse run .ruse/summarize.recipe.mjs              # explicit path still works
ruse recipes                                     # list every recipe visible from cwd
ruse recipes new                                 # author a new recipe via the recipe-author agent
ruse recipes explain                             # ask the recipe-guide agent how the kit works
ruse edit                                        # open the global ruse dir in your editor
ruse completion zsh                              # print a shell completion script
```

`ruse run <name>` looks for the recipe in this order — **project always
shadows global**:

1. Nearest `.ruse/<name>.recipe.mjs` (or `<name>.mjs`) walking up from cwd.
2. `<user-recipes>/<name>.recipe.mjs` (or `<name>.mjs`).

If the argument is an existing file path, that wins — long-form paths still
work unchanged.

`ruse init [dir]` drops a ready-to-edit `.ruse/` folder (recipe + reusable
script + prompt) into a project without overwriting anything that exists.

## Global (user-scope) recipes

Drop a recipe into `<user-recipes>` and it's runnable from anywhere,
without any `.ruse/` folder in the project. `<user-recipes>` is:

| Precedence | Location |
|---|---|
| 1 | `$RUSE_HOME/recipes` (if `RUSE_HOME` is set) |
| 2 | `$XDG_CONFIG_HOME/ruse/recipes` |
| 3 | `~/.config/ruse/recipes` |

To install a recipe globally, just copy it:

```bash
mkdir -p ~/.config/ruse/recipes
cp my-recipe.recipe.mjs ~/.config/ruse/recipes/
ruse run my-recipe        # now works from anywhere
```

`ruse recipes` lists every visible recipe grouped by scope — useful to see
which name would win when both scopes define one.

## Variables (`ruse config`)

`ruse config` manages small, user-defined variables in a JSON file per scope.
This is storage only — variable substitution into recipes is a separate,
deliberate follow-up.

```bash
ruse config list                                    # merged view (project > user > global)
ruse config list --scope user                       # just one scope
ruse config define api_url https://example.com      # writes to project by default
ruse config define retries 3                        # values that parse as JSON keep their type
ruse config define --scope user default_model haiku
ruse config define editor vim --scope global
```

Three scopes with a clear precedence for reads:

| Precedence | Scope | Path | Meaning |
|---|---|---|---|
| 1 | `project` | `<nearest .ruse/>/config.json` | Checked in with the repo. |
| 2 | `user` | `<user-config>/config.json` | Per-user, per-machine. |
| 3 | `global` | `<user-config>/global.config.json` | Per-user, portable (dotfiles-syncable). |

`<user-config>` follows the same rules as `<user-recipes>`: `$RUSE_HOME`, else
`$XDG_CONFIG_HOME/ruse`, else `~/.config/ruse`. `ruse config list` (no
`--scope`) shows the merged view and flags shadowed names so it's obvious
which scope wins. The default scope for `define` is `project` — the most
conservative choice, matching how recipes resolve.

Variable names must match `/^[A-Za-z_][A-Za-z0-9_]*$/`. Values are parsed as
JSON when possible so numbers, booleans, arrays, and objects round-trip as
their real types; anything that isn't valid JSON is stored as a string.

### Reading variables from a recipe

The kit exposes `config` — a namespaced, deterministic helper that returns the
merged view (same precedence: project > user > global). Values are resolved
once per run and cached for the recipe's lifetime.

```js
export default async function ({ config, sh, log }) {
  // Optional value with a fallback.
  const model = config.get('default_model') ?? 'haiku';

  // Required value — throws with a helpful message if unset.
  const apiUrl = config.require('api_url');

  // Whole merged snapshot when you need it.
  log(JSON.stringify(config.all()));

  await sh(`curl -sSf "${apiUrl}/ping"`);
}
```

- `config.get(name)` returns the value, or `undefined` when unset.
- `config.require(name)` returns the value, or throws
  `Missing required variable "<name>". Define it with: ruse config define <name> <value>`.
- `config.all()` returns a fresh copy of the merged `{ name: value }` map.

No environment-variable fallback — only values written via `ruse config define`
are visible. Read judgment is on the recipe: use `.get()` when a default makes
sense, `.require()` when the recipe cannot run without it.

### Authoring and understanding recipes via an agent

Two subcommands hand you an interactive Claude Code session with an agent
bundled inside ruse — no need to clone the repo or install anything else:

| Command | Agent | Writes files? |
|---|---|---|
| `ruse recipes new` | `recipe-author` | yes — into the **global** ruse dir (`<user-recipes>`) |
| `ruse recipes explain` | `recipe-guide` | no — read-only |

Both operate at the user (global) scope: `ruse recipes new` writes the recipe
file, helper scripts, and prompt bodies into `<user-recipes>` (see the table
above) regardless of where you invoke it. If you want a project-local recipe
instead, edit files under `.ruse/` directly — that layout is unchanged.

These commands require the `claude` CLI to be installed and on your `PATH`.

After `ruse recipes new` finishes, if the agent actually created or modified
any files in the global dir, you will be asked whether to open the dir in
your editor. The prompt is skipped when nothing changed.

### Opening the global dir directly

```bash
ruse edit           # opens <user-recipes> in $VISUAL, $EDITOR, or a detected IDE
```

The lookup order matches what `git`/`gh` use:

1. `$VISUAL` (split on whitespace, so `VISUAL="code --wait"` works).
2. `$EDITOR`.
3. First of these found on `PATH`: `code`, `cursor`, `windsurf`, `zed`,
   `subl`, `idea`.
4. Platform fallback: `open` on macOS, `xdg-open` on Linux.

If nothing is found, `ruse edit` prints a message telling you to set
`$EDITOR` and exits non-zero.

## Shell completion

`ruse completion <bash|zsh|fish>` prints a completion script to stdout that
completes both top-level subcommands and (after `ruse run`) recipe names
from the merged project + global scope.

| Shell | Install |
|---|---|
| bash | `source <(ruse completion bash)` in `~/.bashrc` |
| zsh  | `ruse completion zsh > "${fpath[1]}/_ruse"` then restart the shell |
| fish | `ruse completion fish > ~/.config/fish/completions/ruse.fish` |

## The toolkit

| Helper | Cost | What it does |
|---|---|---|
| `ask(q, {choices, default})` | free | Prompt the user on stdin. |
| `run(path, {args, input, env, stream})` | free | Run a `.js/.mjs/.sh/.ps1/.py` script; returns stdout. `stream: true` tees output live while capturing. |
| `sh(cmd, {input, env, stream})` | free | Run an inline shell command; returns stdout. `stream: true` behaves the same. On non-zero exit both throw with `.output` + `.exitCode` attached. |
| `prompt(textOrFile, {model, agent, skill, sessionId, input, context, allowedTools, permissionMode})` | **LLM** | One Claude turn. `.md/.txt` paths load as the prompt body. |
| `agent(name, text, opts)` | **LLM** | `prompt` shorthand that runs as a named agent. |
| `context(name, textOrFile, opts)` | **LLM** | Like `prompt` but `schema` is required; result lands on `state.context[name]` for reuse. |
| `use(path)` | free | Import helpers/data from another module for reuse. |
| `handoff(recipe, extraState)` | — | Run another recipe, sharing `state`. |
| `config.get(name)` / `config.require(name)` / `config.all()` | free | Read merged `ruse config` variables (project > user > global). |
| `state` | — | Mutable object threaded across steps and handoffs. |
| `kit.args` | — | Args passed after `--`. |

## How LLM steps work

Each `prompt`/`agent` shells out to your installed `claude` CLI
(`claude -p --output-format json`), so recipes inherit your existing auth,
skills, MCP servers, and settings. Options map to real flags:
`model → --model`, `agent → --agent`, `sessionId → --resume` (share context
between prompts), `skill` prepends `/skill-name`, `input` is appended to the
prompt body. Every call is counted and its cost summarized at the end.

## Structured output

Pass a JSON Schema as `schema` and `prompt`/`agent` return a parsed, validated
object on `res.data` — so LLM output flows straight into deterministic code:

```js
const { data } = await prompt('Extract the person from that bio', {
  model: 'haiku',
  input: bioText,
  schema: {
    type: 'object',
    required: ['name', 'age'],
    properties: { name: { type: 'string' }, age: { type: 'number' } },
  },
});
console.log(data.name, data.age + 1);   // real number, not a string
```

The runtime appends the schema to the prompt, strips any code fences from the
reply, parses it, and does a light structural check (type + required fields).
On a mismatch it makes **one** self-correcting retry (resuming the same
session) before throwing — both attempts are counted in the ledger.

## Shared context

Build a structured context once, then reuse it across several prompts without
re-running the work. `context(name, textOrFile, opts)` costs one LLM call
(`schema` is required so the result is inspectable), and stores
`{ data, sessionId, model }` at `state.context[name]`. Later prompts pull
those blocks in with `{ context: [...names] }`:

```js
await context('repoMap', 'prompts/repo_map.md', { model: 'haiku', input: files, schema });
await context('style',   'prompts/style_notes.md', { model: 'haiku', input: readme, schema });

const { text: blurb }   = await prompt('prompts/blurb.md',   { model: 'haiku', context: ['repoMap', 'style'] });
const { text: tagline } = await prompt('prompts/tagline.md', { model: 'haiku', context: ['repoMap', 'style'] });
```

Each named context is rendered as a stable `## Context: <name>` block
prepended to the prompt, in the order you pass — that stable ordering is what
makes the prefix cache-friendly. If every referenced context shares a
`sessionId` (and the call has no explicit `sessionId`), the runtime
auto-threads to it so Claude's KV cache can hit; conflicts skip auto-threading
and log a note.

## Design principle

Deterministic first. An LLM call is a deliberate, visible line in the recipe —
never the default way to move data from one step to the next.

## Development

Hacking on the CLI itself? See [DEVELOPMENT.md](./DEVELOPMENT.md) for the
source-tree layout, local-dev workflow, and the three Claude Code subagents
shipped in `.claude/agents/`:

- [`recipe-author`](.claude/agents/recipe-author.md) — builds/edits recipes.
- [`recipe-guide`](.claude/agents/recipe-guide.md) — explains the kit API (read-only).
- [`ruse-dev`](.claude/agents/ruse-dev.md) — works on the CLI itself.
