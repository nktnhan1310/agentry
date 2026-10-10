// Engine adapters: each returns { ok, text, tail, costUsd }.
import { run } from './proc.mjs';

// Token saving: `--tools` loads only these tool definitions and `--strict-mcp-config` skips MCP servers.
// Measured: ~22.6k → ~6.1k context tokens per call, re-sent on every turn.
const READ_TOOLS = 'Read,Grep,Glob';
const WRITE_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash';
const DENY = ['Bash(git push:*)', 'Bash(git commit:*)', 'Bash(git reset:*)', 'Bash(git checkout:*)', 'Bash(rm -rf:*)'];

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

async function claude(prompt, { cwd, model, write, log, timeoutMin, ticketId, budgetUsd }) {
  const local = localModel(model);
  const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config',
    '--tools', write ? WRITE_TOOLS : READ_TOOLS,
    '--permission-mode', write ? 'acceptEdits' : 'dontAsk',
    '--allowedTools', ...(write ? ['Bash'] : ['Read', 'Grep', 'Glob']), '--disallowedTools', ...DENY];
  if (model) args.push('--model', local ? local.model : model);
  if (budgetUsd && !local) args.push('--max-budget-usd', String(budgetUsd));
  // Prompt via stdin: no shell quoting issues, no command-line length limit.
  const r = await run('claude', args, { cwd, log, timeoutMin, ticketId, input: prompt, env: local?.env });
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
