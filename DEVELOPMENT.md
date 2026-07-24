# Developing `ruse`

Hacking on the CLI itself (not authoring recipes — for that, see the main
[README](./README.md)).

## Layout

```
src/
  cli.mjs        entry point — arg parsing, `run | init | recipes | completion | __complete`,
                 recipe resolution (`resolveRecipe`), and the handwritten
                 bash/zsh/fish completion scripts
  runtime.mjs    the toolkit handed to recipes (ask/run/sh/prompt/agent/…)
                 and the ledger that counts LLM calls
  claude.mjs     thin wrapper around the `claude` CLI (`-p --output-format json`)
  init.mjs       `ruse init` scaffolder — drops a starter .ruse/ into a project
  recipes.mjs    launcher for `ruse recipes new | explain` — spawns an
                 interactive claude session with the bundled subagent
examples/        end-user example recipe (used by tests + docs)
.ruse/           this repo's own recipes (dogfooding)
.claude/agents/  the three Claude Code subagents (see below)
```

## Local development

```bash
git clone git@github.com:stylo-stack/ruse.git
cd ruse
npm link                                # or: pnpm link --global
ruse --help                             # sanity check
node src/cli.mjs run pnpm-gauntlet --dry-run   # run without linking
```

There's no build step, no test framework, and no runtime deps — everything is
plain Node ≥ 18. Keep it that way unless a change genuinely earns a dependency.

## Design principles

1. **Deterministic first.** `ask/run/sh` are free. `prompt/agent` are the only
   token-spending calls. That distinction is the whole point of the tool —
   don't blur it.
2. **No hidden LLM calls.** Every token spend must be a visible line in a
   recipe. The ledger reports the exact count at the end of each run.
3. **Small surface.** The kit is intentionally tiny. Add a helper only if it
   removes real friction from actual recipes — not for hypothetical ones.
4. **Recipes are user code.** The runtime shouldn't second-guess or wrap
   recipe output. Failures throw; the CLI reports them.

## Claude Code agents

Three specialized subagents live in `.claude/agents/`. Claude Code picks them
up automatically when this folder is the working directory.

| Agent | Writes files? | Use for |
|---|---|---|
| [`recipe-author`](.claude/agents/recipe-author.md) | yes | Building a new recipe or editing an existing one. Validates with `ruse run … --dry-run`. |
| [`recipe-guide`](.claude/agents/recipe-guide.md) | **no** | Explaining the kit API, the "minimize LLM use" philosophy, or why a recipe misbehaves. Read-only by design — teaching is cheaper than generating. |
| [`ruse-dev`](.claude/agents/ruse-dev.md) | yes | Changing the CLI itself — new kit helpers, CLI flags, completion, init templates, bug fixes. **Not** for authoring end-user recipes. |

Pick the narrowest one that fits — `recipe-guide` before `recipe-author`,
`recipe-author` before `ruse-dev`. Using the wrong scope wastes tokens and
tends to produce over-broad changes.

`recipe-author` and `recipe-guide` are also shipped in the npm tarball
(`.claude/agents/` is listed in `package.json → files`) so end users can
invoke them via `ruse recipes new` and `ruse recipes explain` without cloning
the repo. `ruse-dev` is deliberately not surfaced by the CLI — it is for
working on ruse itself. See `src/recipes.mjs` for the dispatcher: it reads the
`.md` files, parses the frontmatter, and passes the agent definition inline
to `claude --agents` so agent discovery does not depend on the user's local
`~/.claude/` state.

## Publishing

The package is not on npm yet. To publish:

```bash
npm login
npm publish --access public
```

Once published, the install lines in the [README](./README.md#install) should
be updated from `github:stylo-stack/ruse` to bare `rational-use`.

## Contributing

Small, focused PRs. Match the existing style (no semicolons-vs-no-semicolons
churn, no reformatting-only commits). If a change touches recipe behavior,
add or update an entry under `examples/`.
