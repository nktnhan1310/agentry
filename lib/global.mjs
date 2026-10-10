import { homedir } from 'node:os';
import { join } from 'node:path';
import * as opencode from '../adapters/opencode.mjs';
import { loadSources } from './sources.mjs';
import { loadConfig } from './sync.mjs';
import { fm, KIT, toPosix, write } from './util.mjs';

// Installs a `/kit-sync` command into the user-level Claude Code and OpenCode command folders.
export function installGlobal() {
  const cli = `${toPosix(KIT)}/bin/kit.mjs`;
  const body = [
    `Run \`node "${cli}" sync . $ARGUMENTS\` in the repo root and show its output verbatim (already compact).`,
    'If files were skipped as locally modified, list them and ask whether to re-run with --force or move the edits to .kit/local/.',
    'If it reports CLAUDE.md/AGENTS.md over budget, offer to run the wiki skill "slim" procedure.',
    '',
  ].join('\n');
  const desc = 'Sync agentry agents, skills, commands and hooks into this repo';
  const targets = [
    join(homedir(), '.claude', 'commands', 'kit-sync.md'),
    join(homedir(), '.config', 'opencode', 'commands', 'kit-sync.md'),
  ];
  write(targets[0], fm({ description: desc, 'argument-hint': '[--dry] [--force] [--packs a,b] [--tools claude,opencode,codex]' }) + body);
  write(targets[1], fm({ description: desc }) + body);

  // `/ticket <request>` queues work for the background hub loop from inside a Claude Code or OpenCode session.
  const ticket = [
    'Queue a ticket for the background hub loop (it plans, codes, verifies, reviews, commits on a branch and stops before push/PR). Do NOT do the work yourself.',
    'Request: $ARGUMENTS',
    '1. Title: one imperative line. If the request refers to this conversation ("this", "what we discussed"), use that context.',
    '2. Write `.kit/handoff/new-ticket.md` (overwrite): goal, files/symbols already known from this session, acceptance criteria, out of scope. ≤15 lines. Do not explore the code for it; the planner will.',
    '3. Add `--quick` only if the request says quick/small or it is an obvious one-file change; `--backlog` if it says draft/later.',
    `4. Run: \`node "${cli}" hub add . "<title>" --desc-file .kit/handoff/new-ticket.md\` plus those flags, and show the output.`,
    `5. If it says the daemon is not running, offer to run \`node "${cli}" hub start\`.`,
    '',
  ].join('\n');
  const tdesc = 'Queue a hub ticket for this repo (background plan → code → review, stops before PR)';
  targets.push(join(homedir(), '.claude', 'commands', 'ticket.md'), join(homedir(), '.config', 'opencode', 'commands', 'ticket.md'));
  write(targets.at(-2), fm({ description: tdesc, 'argument-hint': '<what to do> [quick] [draft]' }) + ticket);
  write(targets.at(-1), fm({ description: tdesc }) + ticket);

  // The hub loop runs `opencode run --agent kit-worker` in fresh worktrees, which may not contain the kit yet.
  const files = new Map();
  opencode.render(loadSources(null, []), { cfg: { ...loadConfig(), tools: ['opencode'] }, emit: (p, c) => files.set(p, c), merge() {} });
  const worker = files.get('.opencode/agents/kit-worker.md');
  targets.push(join(homedir(), '.config', 'opencode', 'agents', 'kit-worker.md'));
  write(targets.at(-1), worker.replaceAll('.opencode/skills/', '.claude/skills/'));
  return `installed /kit-sync, /ticket, kit-worker:\n${targets.map((t) => `  ${t}`).join('\n')}`;
}
