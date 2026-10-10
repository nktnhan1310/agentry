// Engine adapters: each returns { ok, text, tail, costUsd }.
import { run } from './proc.mjs';

// Headless Claude on Windows exposes its shell as `PowerShell`, not `Bash` (measured: with only Bash
// listed, the session had no shell at all). Both are listed there, each with the same deny rules.
const shells = (platform) => (platform === 'win32' ? ['Bash', 'PowerShell'] : ['Bash']);
// `git * push*` also catches `git -C <worktree> push`, which a plain prefix rule misses.
const GIT_DENY = ['push', 'commit', 'reset', 'checkout', 'switch', 'stash', 'rebase'];
const deny = (sh) => sh.flatMap((s) => [...GIT_DENY.flatMap((g) => [`${s}(git ${g}*)`, `${s}(git * ${g}*)`]), `${s}(rm -rf*)`, `${s}(Remove-Item*-Recurse*)`]);

/**
 * Token saving: `--tools` loads only these tool definitions and `--strict-mcp-config` skips MCP servers
 * (measured ~22.6k → ~6.1k context tokens per call, re-sent on every turn).
 * mode: read (plan, review) · write (code) · run (test: shell, no edits).
 */
export function claudeArgs({ mode = 'read', model, budgetUsd, agent, addDirs = [], platform = process.platform }) {
  const sh = shells(platform);
  const tools = { read: ['Read', 'Grep', 'Glob'], write: ['Read', 'Grep', 'Glob', 'Edit', 'Write', ...sh], run: ['Read', 'Grep', 'Glob', ...sh] }[mode];
  const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config',
    '--tools', tools.join(','),
    '--permission-mode', mode === 'read' ? 'dontAsk' : 'acceptEdits',
    '--allowedTools', ...(mode === 'read' ? tools : sh), '--disallowedTools', ...deny(sh)];
  if (agent) args.push('--agent', agent);
  for (const d of addDirs) args.push('--add-dir', d);
  if (model) args.push('--model', model);
  if (budgetUsd) args.push('--max-budget-usd', String(budgetUsd));
  return args;
}

// KIT_CLAUDE_BIN swaps the binary (tests use a .mjs stub run by node).
function claudeBin(args) {
  const bin = process.env.KIT_CLAUDE_BIN || 'claude';
  return /\.m?js$/.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args];
}

// `ollama/<model>` runs Claude Code against local Ollama's Anthropic-compatible API (free, no budget cap).
// All model aliases map to it, since Claude Code also makes background haiku/sonnet calls.
export function localModel(model) {
  if (!model?.startsWith('ollama/')) return null;
  const m = model.slice('ollama/'.length);
  return { model: m, env: {
    ANTHROPIC_BASE_URL: process.env.KIT_OLLAMA_URL || 'http://localhost:11434',
    ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_API_KEY: '',
    ANTHROPIC_DEFAULT_OPUS_MODEL: m, ANTHROPIC_DEFAULT_SONNET_MODEL: m, ANTHROPIC_DEFAULT_HAIKU_MODEL: m,
  } };
}

async function claude(prompt, { cwd, model, write, mode, agent, addDirs, log, timeoutMin, ticketId, budgetUsd }) {
  const local = localModel(model);
  const [cmd, args] = claudeBin(claudeArgs({ mode: mode || (write ? 'write' : 'read'), model: local ? local.model : model,
    budgetUsd: local ? undefined : budgetUsd, agent, addDirs }));
  // Prompt via stdin: no shell quoting issues, no command-line length limit.
  const r = await run(cmd, args, { cwd, log, timeoutMin, ticketId, input: prompt, env: local?.env });
  let j = {};
  try { j = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { /* non-JSON failure */ }
  return { ok: r.code === 0 && !j.is_error, text: (j.result || '').trim(), tail: r.tail, costUsd: local ? 0 : j.total_cost_usd || 0 };
}

async function opencode(prompt, { cwd, model, log, timeoutMin, ticketId, agent = 'kit-worker' }) {
  // opencode ships as a .cmd/.ps1 shim on Windows, so it needs a shell; keep the message free of quotes.
  const msg = prompt.replace(/"/g, "'").replace(/\r?\n/g, ' ');
  const args = ['run', '--agent', agent, '--auto', ...(model ? ['-m', model] : []), `"${msg}"`];
  const r = await run('opencode', args, { cwd, log, timeoutMin, ticketId, shell: true });
  return { ok: r.code === 0 && !/^Error:/m.test(r.tail), text: r.tail.split('\n').slice(-20).join('\n'), tail: r.tail, costUsd: 0 };
}

export function engine(tool) {
  if (tool === 'claude') return claude;
  if (tool === 'opencode') return opencode;
  throw new Error(`unknown engine tool "${tool}" (claude|opencode)`);
}

export const shell = (cmd, opts) => run(cmd, [], { ...opts, shell: true });
