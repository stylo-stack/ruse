// Thin wrapper around the installed `claude` CLI, used for every LLM step.
// We shell out (rather than reimplement an agent loop) so recipes inherit the
// user's existing auth, skills, MCP servers, and settings for free.

import { spawn } from 'node:child_process';

/**
 * Run a single non-interactive Claude turn.
 *
 * @param {string} promptText   The user prompt (may start with `/skill-name`).
 * @param {object} [opts]
 * @param {string} [opts.model]          Alias ('haiku','sonnet','opus') or full id.
 * @param {string} [opts.agent]          Named agent to run as.
 * @param {string} [opts.sessionId]      Resume this session id to share context.
 * @param {string} [opts.system]         Appended to the system prompt.
 * @param {string[]} [opts.allowedTools] Tool allowlist, e.g. ['Bash(git *)','Read'].
 * @param {string} [opts.permissionMode] 'default'|'acceptEdits'|'auto'|'bypassPermissions'
 * @param {string} [opts.cwd]            Working directory for the turn.
 * @param {string[]} [opts.addDir]       Extra directories Claude may access.
 * @returns {Promise<{text:string, sessionId:string, costUsd:number, usage:object, raw:object}>}
 */
export function claude(promptText, opts = {}) {
  const args = ['-p', '--output-format', 'json'];

  if (opts.model) args.push('--model', opts.model);
  if (opts.agent) args.push('--agent', opts.agent);
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  if (opts.system) args.push('--append-system-prompt', opts.system);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.allowedTools?.length) args.push('--allowedTools', opts.allowedTools.join(' '));
  for (const dir of opts.addDir ?? []) args.push('--add-dir', dir);

  // Prompt goes last, via stdin to avoid arg-length / escaping limits.
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', (err) =>
      reject(new Error(`Failed to launch \`claude\`: ${err.message}. Is it installed and on PATH?`)),
    );
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}`));
        return;
      }
      let json;
      try {
        json = JSON.parse(stdout);
      } catch {
        // --output-format json should always be JSON; fall back to raw text.
        resolve({ text: stdout.trim(), sessionId: '', costUsd: 0, usage: emptyUsage(), raw: {} });
        return;
      }
      const u = json.usage ?? {};
      resolve({
        text: json.result ?? json.text ?? '',
        sessionId: json.session_id ?? '',
        costUsd: json.total_cost_usd ?? 0,
        usage: {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheCreation: u.cache_creation_input_tokens ?? 0,
        },
        raw: json,
      });
    });

    child.stdin.write(promptText);
    child.stdin.end();
  });
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}
