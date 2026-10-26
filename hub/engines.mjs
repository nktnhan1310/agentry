// Engine adapters: each returns { ok, text, tail, costUsd }.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { run } from './proc.mjs';

// Headless Claude on Windows exposes its shell as `PowerShell`, not `Bash` (measured: with only Bash
// listed, the session had no shell at all). Both are listed there, each with the same deny rules.
const shells = (platform) => (platform === 'win32' ? ['Bash', 'PowerShell'] : ['Bash']);
// `git * push*` also catches `git -C <worktree> push`, which a plain prefix rule misses.
const GIT_DENY = ['push', 'commit', 'reset', 'checkout', 'switch', 'stash', 'merge', 'rebase'];
const deny = (sh) => sh.flatMap((s) => [...GIT_DENY.flatMap((g) => [`${s}(git ${g}*)`, `${s}(git * ${g}*)`]), `${s}(rm -rf*)`, `${s}(Remove-Item*-Recurse*)`]);

/**
 * Token saving: `--tools` loads only these tool definitions and `--strict-mcp-config` skips MCP servers
 * (measured ~22.6k → ~6.1k context tokens per call, re-sent on every turn).
 * mode: read (plan, review) · write (code) · run (test: shell, no edits).
 */
export function claudeArgs({ mode = 'read', model, budgetUsd, agent, addDirs = [], platform = process.platform }) {
  const sh = shells(platform);
  const tools = { read: ['Read', 'Grep', 'Glob'], write: ['Read', 'Grep', 'Glob', 'Edit', 'Write', ...sh], run: ['Read', 'Grep', 'Glob', ...sh] }[mode];
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence', '--strict-mcp-config',
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
    // Ollama sends no bytes while it builds a tool call; Claude Code drops a stream idle for 5 min (its minimum)
    // and retries forever on a slow local GPU. Allow 30 min per turn; the stage timeout still caps the run.
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: LOCAL_TURN_MS, CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS: LOCAL_TURN_MS, API_TIMEOUT_MS: LOCAL_TURN_MS,
  } };
}
const LOCAL_TURN_MS = String(30 * 60_000);

// Any HTTP answer counts; only a refused/timed-out connection means the server is down.
export async function reachable(url, ms = 3000) {
  try { await fetch(url, { signal: AbortSignal.timeout(ms) }); return true; } catch { return false; }
}

// stream-json events → a readable live log: model thinking/text as it streams, each tool call and its result.
const clock = () => new Date().toTimeString().slice(0, 8);
const one = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const toolArg = (i = {}) => i.file_path || i.path || i.pattern || i.command || i.description || i.url || '';

export const kTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n || 0));
// Prompt tokens include cache reads/writes: that is what the model actually processed for the turn.
export const usageOf = (u = {}) => ({ in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: u.output_tokens || 0 });

export function streamLogger() {
  let open = false; // a thinking/text block is mid-stream
  let turn = 0;
  let msg = { in: 0, out: 0 }; // current model turn
  const end = () => (open ? ((open = false), '\n') : '');
  const asking = () => `${clock()} ⋯ waiting for the model (turn ${++turn})\n`;
  const fn = (line) => {
    let e;
    try { e = JSON.parse(line); } catch { return `${line}\n`; }
    if (e.type === 'system' && e.subtype === 'init') return `${clock()} ▶ started · model ${e.model}\n${asking()}`;
    if (e.type === 'stream_event') {
      const ev = e.event || {};
      if (ev.type === 'message_start') { msg = usageOf(ev.message?.usage); return ''; }
      if (ev.type === 'message_delta') { const u = usageOf(ev.usage); msg = { in: u.in || msg.in, out: u.out || msg.out }; return ''; }
      if (ev.type === 'message_stop') { fn.total.in += msg.in; fn.total.out += msg.out; }
      if (ev.type === 'message_stop') return `${end()}${clock()}    🪙 ${kTok(msg.in)} in · ${kTok(msg.out)} out\n`;
      if (ev.type === 'content_block_start' && ['thinking', 'text'].includes(ev.content_block?.type)) {
        open = true;
        return `${clock()} ${ev.content_block.type === 'thinking' ? '💭' : '💬'} `;
      }
      if (ev.type === 'content_block_delta' && open) return ev.delta?.thinking ?? ev.delta?.text ?? '';
      if (ev.type === 'content_block_stop') return end();
      return '';
    }
    const content = e.message?.content || [];
    if (e.type === 'assistant') return content.filter((c) => c.type === 'tool_use').map((c) => `${end()}${clock()} 🔧 ${c.name} ${one(toolArg(c.input), 160)}\n`).join('');
    if (e.type === 'user') {
      const res = content.filter((c) => c.type === 'tool_result').map((c) => {
        const text = typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join('\n');
        return `${clock()}    ${c.is_error ? `✗ ${one(text, 300)}` : `↳ ok (${text.split('\n').length} lines)`}\n`;
      }).join('');
      return res && res + asking();
    }
    if (e.type === 'result') {
      const u = usageOf(e.usage);
      return `${end()}${clock()} ■ ${e.is_error ? 'failed' : 'done'} · ${e.num_turns ?? '?'} turns · ${Math.round((e.duration_ms || 0) / 1000)}s${u.in || u.out ? ` · 🪙 ${kTok(u.in)} in / ${kTok(u.out)} out` : ''}${e.total_cost_usd ? ` · $${e.total_cost_usd.toFixed(4)}` : ''}\n${e.result ? `${String(e.result).trim()}\n` : ''}`;
    }
    return '';
  };
  fn.total = { in: 0, out: 0 }; // summed per turn, so stopped/timed-out runs still count
  return fn;
}

async function claude(prompt, { cwd, model, write, mode, agent, addDirs, log, timeoutMin, ticketId, budgetUsd }) {
  const local = localModel(model);
  const [cmd, args] = claudeBin(claudeArgs({ mode: mode || (write ? 'write' : 'read'), model: local ? local.model : model,
    budgetUsd: local ? undefined : budgetUsd, agent, addDirs }));
  // Claude Code retries a refused connection for ~3 min; fail in a second when Ollama isn't running.
  if (local && !(await reachable(local.env.ANTHROPIC_BASE_URL))) {
    const tail = `Ollama is not reachable at ${local.env.ANTHROPIC_BASE_URL}: start it (and enable it in Startup apps) or set KIT_OLLAMA_URL`;
    if (log) { mkdirSync(dirname(log), { recursive: true }); appendFileSync(log, `${tail}\n`); }
    return { ok: false, text: '', tail, costUsd: 0, tokens: { in: 0, out: 0 } };
  }
  // Prompt via stdin: no shell quoting issues, no command-line length limit.
  const logger = streamLogger();
  const r = await run(cmd, args, { cwd, log, logLine: logger, timeoutMin, ticketId, input: prompt, env: local?.env });
  let j = {};
  for (const l of r.out.split(/\r?\n/).reverse()) {
    if (!l.includes('"type":"result"')) continue;
    try { j = JSON.parse(l); break; } catch { /* keep looking */ }
  }
  return { ok: r.code === 0 && !j.is_error, text: (j.result || '').trim(), tail: r.tail, costUsd: local ? 0 : j.total_cost_usd || 0, tokens: j.usage ? usageOf(j.usage) : logger.total };
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
