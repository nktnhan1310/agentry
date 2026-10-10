import { homedir } from 'node:os';
import { join } from 'node:path';
import * as opencode from '../adapters/opencode.mjs';
import { loadSources } from './sources.mjs';
import { loadConfig } from './sync.mjs';
import { fm, KIT, toPosix, write } from './util.mjs';

// Installs a `/kit-sync` command into the user-level Claude Code and OpenCode command folders.
export function installGlobal({ projects } = {}) {
  projects = toPosix(projects || join(homedir(), 'projects'));
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
  // `/kit-new <idea>` starts a project from an empty session: stack → scaffold → kit → wiki → MVP tickets.
  const kitNew = [
    'Start a new project with agentry. Idea: $ARGUMENTS',
    '1. If the idea, users, stack or name is unclear, ask ≤3 questions in ONE message, each with your recommended answer. Stacks with packs: Next.js+Supabase, Python FastAPI+Supabase, .NET API+React, Next.js.',
    `2. Folder: ${projects}/<kebab-name> unless told otherwise.` + ` Read the matching ${toPosix(KIT)}/packs/<pack>/SKILL.md first, then scaffold` + ' with the official tool (uv init / pnpm create next-app / dotnet new): the smallest working app, one passing test, lint config, .env.example (real secrets only in gitignored .env).',
    `3. Run \`node "${cli}" new <folder>\` (git init + kit sync; detects packs and build/test/lint).`,
    '4. Write .wiki/arch.md (≤40 lines: modules, data model, auth, config, deploy) and .wiki/plans/mvp.md: the MVP as 5–10 small tickets (title, goal, acceptance). Keep AGENTS.md ≤10 lines.',
    '5. Run build/test/lint until green, then commit "chore: scaffold <name>".',
    `6. Offer to register with the loop (\`node "${cli}" hub repo add <folder>\`) and queue the MVP tickets (\`hub add <folder> "<title>" --desc-file …\`), or build them here with /impl.`,
    '',
  ].join('\n');
  const ndesc = 'Start a new project: pick stack, scaffold, install agentry, write arch + MVP ticket plan';
  targets.push(join(homedir(), '.claude', 'commands', 'kit-new.md'), join(homedir(), '.config', 'opencode', 'commands', 'kit-new.md'));
  write(targets.at(-2), fm({ description: ndesc, 'argument-hint': '<project idea>' }) + kitNew);
  write(targets.at(-1), fm({ description: ndesc }) + kitNew);

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
  return `installed /kit-sync, /kit-new, /ticket, kit-worker:\n${targets.map((t) => `  ${t}`).join('\n')}`;
}
