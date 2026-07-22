// The toolkit handed to every recipe. Deterministic helpers (ask/run/sh) are
// zero-cost; `prompt`/`agent` are the ONLY calls that spend LLM tokens, so they
// stay explicit and easy to audit — that is the whole point of the tool.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { extname, resolve as resolvePath, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { claude } from './claude.mjs';
import { listAll as listAllVars } from './config.mjs';

/** Per-run accounting so we can report exactly how much LLM was used. */
export class Ledger {
  constructor() {
    this.scriptSteps = 0;
    this.llmCalls = 0;
    this.costUsd = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheCreationTokens = 0;
  }
  addUsage(usage) {
    if (!usage) return;
    this.inputTokens += usage.input ?? 0;
    this.outputTokens += usage.output ?? 0;
    this.cacheReadTokens += usage.cacheRead ?? 0;
    this.cacheCreationTokens += usage.cacheCreation ?? 0;
  }
  totalTokens() {
    return this.inputTokens + this.outputTokens + this.cacheReadTokens + this.cacheCreationTokens;
  }
  summary() {
    const parts = [`${this.scriptSteps} script step(s)`, `${this.llmCalls} LLM call(s)`];
    const total = this.totalTokens();
    if (total) {
      parts.push(`${total.toLocaleString()} tokens (in ${this.inputTokens.toLocaleString()}, out ${this.outputTokens.toLocaleString()}, cache ${(this.cacheReadTokens + this.cacheCreationTokens).toLocaleString()})`);
    }
    if (this.costUsd) parts.push(`~$${this.costUsd.toFixed(4)}`);
    return parts.join(', ');
  }
}

const INTERPRETERS = {
  '.js': ['node'],
  '.mjs': ['node'],
  '.cjs': ['node'],
  '.sh': ['bash'],
  '.bash': ['bash'],
  '.ps1': ['pwsh'],
  '.py': ['python3'],
};

/**
 * Build the toolkit object passed to a recipe's default-exported function.
 *
 * @param {object} cfg
 * @param {string} cfg.recipeDir  Directory of the running recipe (for relative paths).
 * @param {object} cfg.state      Shared mutable state, threaded across handoffs.
 * @param {object} cfg.args       Parsed CLI args passed after `--`.
 * @param {Ledger} cfg.ledger     Run accounting.
 * @param {boolean} cfg.dryRun    If true, LLM steps are skipped and logged instead.
 * @param {(msg:string)=>void} cfg.log
 */
export function makeKit(cfg) {
  const { recipeDir, state, args, ledger, dryRun, log } = cfg;
  const rel = (p) => resolvePath(recipeDir, p);

  // --- Deterministic: read user-defined variables (ruse config) ------------
  // Resolved once, on first access, and cached for the lifetime of this kit
  // instance so a recipe sees a consistent snapshot even if the JSON files
  // change mid-run. Cache is per-kit (per-invocation, effectively per-
  // `ruse run`) — a fresh process, or a fresh `makeKit` via handoff, re-reads
  // the files. `listAllVars` applies the same project > user > global
  // precedence the CLI uses; we flatten to a plain name -> value map so
  // recipes never care which scope a value came from.
  let _varCache;
  function loadVars() {
    if (_varCache) return _varCache;
    const out = Object.create(null);
    for (const entry of listAllVars(process.cwd())) out[entry.name] = entry.value;
    _varCache = out;
    return _varCache;
  }
  const config = {
    // Return the merged value for `name`, or undefined if unset. Undefined
    // matches how `kit.args` / `state` handle absent keys — recipes can
    // supply their own fallbacks with `??`.
    get(name) {
      return loadVars()[name];
    },
    // Same lookup but throw when the value is missing, so recipes can fail
    // loudly at the top instead of silently using undefined downstream.
    require(name) {
      const vars = loadVars();
      if (!(name in vars)) {
        throw new Error(
          `Missing required variable "${name}". Define it with: ruse config define ${name} <value>`,
        );
      }
      return vars[name];
    },
    // Snapshot of every visible variable, merged across scopes. Copied so
    // recipes can mutate it without poisoning the cache.
    all() {
      return { ...loadVars() };
    },
  };

  // --- Deterministic: ask the user for input -------------------------------
  async function ask(question, opts = {}) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (opts.choices?.length) {
        log(question);
        opts.choices.forEach((c, i) => log(`  ${i + 1}) ${c}`));
        const answer = await new Promise((res) => rl.question('> ', res));
        const idx = Number.parseInt(answer, 10) - 1;
        return opts.choices[idx] ?? answer;
      }
      const suffix = opts.default ? ` [${opts.default}]` : '';
      const answer = await new Promise((res) => rl.question(`${question}${suffix} `, res));
      return answer.trim() || opts.default || '';
    } finally {
      rl.close();
    }
  }

  // --- Deterministic: run a script file (js/bash/ps1/py) -------------------
  async function run(scriptPath, opts = {}) {
    const abs = rel(scriptPath);
    const ext = extname(abs).toLowerCase();
    const interp = INTERPRETERS[ext];
    if (!interp) throw new Error(`Don't know how to run "${scriptPath}" (extension ${ext}).`);
    ledger.scriptSteps++;
    return execCapture(interp[0], [...interp.slice(1), abs, ...(opts.args ?? [])], opts);
  }

  // --- Deterministic: run an inline shell command --------------------------
  async function sh(command, opts = {}) {
    ledger.scriptSteps++;
    const shell = process.platform === 'win32' ? 'powershell' : 'bash';
    const flag = process.platform === 'win32' ? '-Command' : '-c';
    return execCapture(shell, [flag, command], opts);
  }

  // --- LLM: one prompt turn (the only token-spending call) -----------------
  async function prompt(promptOrFile, opts = {}) {
    let text = promptOrFile;
    // If it looks like a path to an existing .md/.txt, load it as the prompt body.
    if (/\.(md|txt|prompt)$/i.test(promptOrFile)) {
      text = await readFile(rel(promptOrFile), 'utf8');
    }
    if (opts.skill) text = `/${opts.skill} ${text}`;
    // Shared context blocks: rendered as a byte-stable prefix so Claude's
    // server-side KV cache can hit across sibling calls. Order follows the
    // author's `context: [...]` array — don't sort, they picked the ordering.
    let autoSessionId;
    if (opts.context?.length) {
      const { prefix, sessionId } = renderContext(opts.context, state, log);
      text = `${prefix}${text}`;
      autoSessionId = sessionId;
    }
    if (opts.input != null) {
      const payload = typeof opts.input === 'string' ? opts.input : JSON.stringify(opts.input, null, 2);
      text = `${text}\n\n---\nInput:\n${payload}`;
    }
    // Structured output: ask for JSON matching a schema and hand back parsed data.
    if (opts.schema) {
      text = `${text}\n\n---\nRespond with ONLY a JSON value conforming to this JSON Schema.\n` +
        `No prose, no markdown code fences.\n\nJSON Schema:\n${JSON.stringify(opts.schema, null, 2)}`;
    }
    // Resolve session: explicit opts.sessionId wins; else auto-thread if the
    // referenced contexts agree on one.
    const sessionId = opts.sessionId ?? autoSessionId;
    if (dryRun) {
      log(`[dry-run] would call LLM (model=${opts.model ?? 'default'}${opts.agent ? `, agent=${opts.agent}` : ''}${opts.schema ? ', schema' : ''}${opts.context?.length ? `, context=[${opts.context.join(',')}]` : ''}${sessionId ? ', threaded' : ''})`);
      return { text: '', data: opts.schema ? null : undefined, sessionId: sessionId ?? '', costUsd: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, raw: {} };
    }
    ledger.llmCalls++;
    // LLM steps run at the project root (process.cwd) by default so Claude sees
    // the project's files/CLAUDE.md. Prompt *files* already resolved via rel().
    const label = spinnerLabel(opts);
    const stop = startSpinner(label);
    let res;
    try {
      res = await claude(text, { cwd: process.cwd(), ...opts, sessionId });
    } finally {
      stop();
    }
    ledger.costUsd += res.costUsd;
    ledger.addUsage(res.usage);

    if (opts.schema) {
      let parsed = tryParse(res.text, opts.schema);
      if (parsed.error) {
        // One self-correcting retry, resuming the same session for context.
        log(`schema parse failed (${parsed.error}); asking model to fix…`);
        ledger.llmCalls++;
        const stop2 = startSpinner(`${label} (retry)`);
        let fix;
        try {
          fix = await claude(
            `Your previous reply did not parse as JSON matching the schema: ${parsed.error}.\n` +
              `Resend ONLY the corrected JSON value — no prose, no fences.`,
            { cwd: process.cwd(), ...opts, sessionId: res.sessionId },
          );
        } finally {
          stop2();
        }
        ledger.costUsd += fix.costUsd;
        ledger.addUsage(fix.usage);
        res = fix;
        parsed = tryParse(res.text, opts.schema);
        if (parsed.error) throw new Error(`Could not get valid structured output: ${parsed.error}\nRaw:\n${res.text}`);
      }
      res.data = parsed.value;
    }
    return res;
  }

  // Convenience alias: `agent('name', prompt, opts)` reads better for agent runs.
  async function agent(name, promptText, opts = {}) {
    return prompt(promptText, { ...opts, agent: name });
  }

  // --- LLM: build a reusable, structured context entry ---------------------
  // Same cost as `prompt` but the parsed data lands on `state.context[name]`
  // so later prompts can pull it in via `{ context: ['name', ...] }`.
  async function context(name, promptOrFile, opts = {}) {
    if (!name || typeof name !== 'string') throw new Error('context(name, ...) requires a string name.');
    if (!opts.schema) throw new Error(`context("${name}", ...) requires opts.schema — context must be structured and inspectable.`);
    const res = await prompt(promptOrFile, opts);
    if (!state.context) state.context = {};
    state.context[name] = {
      data: res.data,
      sessionId: res.sessionId,
      model: opts.model ?? 'default',
    };
    return res.data;
  }

  // --- Reuse: import helpers/data from another recipe file -----------------
  async function use(modulePath) {
    return import(pathToFileURL(rel(modulePath)).href);
  }

  // --- Handoff: run another recipe, sharing state --------------------------
  async function handoff(recipePath, extraState = {}) {
    const abs = rel(recipePath);
    const mod = await import(pathToFileURL(abs).href);
    const fn = mod.default;
    if (typeof fn !== 'function') throw new Error(`${recipePath} has no default-exported recipe function.`);
    Object.assign(state, extraState);
    const kit = makeKit({ ...cfg, recipeDir: dirname(abs) });
    return fn(kit);
  }

  return { ask, run, sh, prompt, agent, context, use, handoff, config, state, args, log };
}

/**
 * Build the byte-stable prefix for `opts.context: [...names]`. Also returns
 * a `sessionId` when every referenced context shares the same one — callers
 * use that to auto-thread so Claude's server-side KV cache can hit. Conflicts
 * return no sessionId and log a debug note; the prefix is still rendered.
 */
function renderContext(names, state, log) {
  const store = state.context ?? {};
  const missing = names.filter((n) => !(n in store));
  if (missing.length) {
    const available = Object.keys(store);
    throw new Error(
      `Unknown context name(s): ${missing.map((n) => `"${n}"`).join(', ')}. ` +
        `Available: ${available.length ? available.map((n) => `"${n}"`).join(', ') : '(none)'}.`,
    );
  }
  const blocks = names.map((n) => `## Context: ${n}\n${JSON.stringify(store[n].data, null, 2)}\n\n`);
  const prefix = blocks.join('');
  const sessionIds = names.map((n) => store[n].sessionId).filter(Boolean);
  const unique = new Set(sessionIds);
  let sessionId;
  if (unique.size === 1 && sessionIds.length === names.length) {
    sessionId = sessionIds[0];
  } else if (unique.size > 1) {
    log(`[context] skipping auto-thread: contexts [${names.join(', ')}] have conflicting sessionIds.`);
  }
  return { prefix, sessionId };
}

/**
 * Parse model text into JSON and lightly check it against a schema.
 * Returns {value} on success or {error} on failure — never throws.
 */
function tryParse(text, schema) {
  let s = (text ?? '').trim();
  // Strip a ```json … ``` (or plain ```) fence if the model added one.
  const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) s = fence[1].trim();
  let value;
  try {
    value = JSON.parse(s);
  } catch (e) {
    return { error: `not valid JSON (${e.message})` };
  }
  // Minimal structural checks — enough to trigger a retry, not a full validator.
  if (schema?.type === 'object' && (typeof value !== 'object' || Array.isArray(value) || value === null)) {
    return { error: 'expected a JSON object' };
  }
  if (schema?.type === 'array' && !Array.isArray(value)) {
    return { error: 'expected a JSON array' };
  }
  for (const key of schema?.required ?? []) {
    if (!(key in value)) return { error: `missing required field "${key}"` };
  }
  return { value };
}

function spinnerLabel(opts) {
  const who = opts.agent ? `agent:${opts.agent}` : 'llm';
  const model = opts.model ?? 'default';
  return `${who} thinking (model=${model})`;
}

/**
 * Show progress while an LLM call is in flight. Writes to stderr so it never
 * mixes with a recipe's real stdout output. Animates on a TTY; falls back to
 * one static line when piped/redirected (CI, logs). Returns a stop() that
 * clears the line and reports the elapsed time.
 */
function startSpinner(label) {
  const out = process.stderr;
  const start = Date.now();
  if (!out.isTTY) {
    out.write(`… ${label}\n`);
    return () => {
      const secs = ((Date.now() - start) / 1000).toFixed(1);
      out.write(`✓ ${label} (${secs}s)\n`);
    };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const render = () => {
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    out.write(`\r\x1b[2K${frames[i++ % frames.length]} ${label} ${secs}s`);
  };
  render();
  const timer = setInterval(render, 80);
  return () => {
    clearInterval(timer);
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    out.write(`\r\x1b[2K✓ ${label} (${secs}s)\n`);
  };
}

function execCapture(cmd, argv, opts) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, argv, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (opts.stream) process.stdout.write(d);
    });
    child.on('error', (e) => rej(new Error(`Failed to run ${cmd}: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        const err = new Error(`${cmd} exited with code ${code}`);
        err.output = out.trim();
        err.exitCode = code;
        return rej(err);
      }
      res(out.trim());
    });
    if (opts.input != null) child.stdin.write(String(opts.input));
    child.stdin.end();
  });
}
