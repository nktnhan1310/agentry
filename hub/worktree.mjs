// Ticket worktrees: create one per ticket (path and branch from repo patterns), remove it when done.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runCommand, vars } from './commands.mjs';
import { git } from './proc.mjs';
import { event, fill, getTicket, loadConfig, paths, saveTicket, ticketFile, updateTicket } from './store.mjs';

const logFile = (t, name) => ticketFile(t.id, `logs/${name}.log`);
const tailN = (s, n) => s.split('\n').slice(-n).join('\n');

// A pipeline stop with the ticket status to set (failed, needs_info).
export class Stop extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

export async function ensureWorktree(t, repo) {
  if (t.worktree && existsSync(t.worktree)) return;
  const wt = repo.worktree ? resolve(fill(repo.worktree, vars(t, repo))) : join(loadConfig().worktreeDir || paths.worktrees, t.repo, t.id);
  if (existsSync(wt) && readdirSync(wt).length) throw new Stop('failed', `${wt} already exists; remove it or change the repo's worktree pattern`);
  mkdirSync(join(wt, '..'), { recursive: true });
  const base = repo.base || 'main';
  let start = base;
  if (repo.fetchBase) {
    const f = await git(repo.path, ['fetch', '--quiet', 'origin', base], { log: logFile(t, 'git') });
    if (f.code) throw new Stop('failed', `git fetch origin ${base} failed:\n${tailN(f.tail, 10)}`);
    start = `origin/${base}`;
  } else if ((await git(repo.path, ['remote', 'get-url', 'origin'])).code === 0) {
    // Branch from the remote base when there is one: the local one is often behind (e.g. PRs merged on GitHub, never pulled).
    const f = await git(repo.path, ['fetch', '--quiet', 'origin', base], { log: logFile(t, 'git') });
    if (f.code === 0) start = `origin/${base}`;
    else event(t, `fetch origin ${base} failed; branching from local ${base}`);
  }
  const head = await git(repo.path, ['rev-parse', '--verify', '--quiet', `${start}^{commit}`]);
  if (head.code) throw new Stop('failed', `base "${start}" not found in ${repo.path}`);
  const exists = (await git(repo.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`])).code === 0;
  if (!exists && repo.fetchBase && (await git(repo.path, ['ls-remote', '--heads', 'origin', t.branch])).out.trim()) {
    throw new Stop('failed', `branch ${t.branch} already exists on origin (in flight elsewhere?); not starting a second one`);
  }
  // --no-track: a branch cut from origin/<base> must not get <base> as its upstream (a bare push would go there).
  const r = await git(repo.path, exists ? ['worktree', 'add', wt, t.branch] : ['worktree', 'add', '--no-track', '-b', t.branch, wt, start], { log: logFile(t, 'git') });
  if (r.code) throw new Stop('failed', `worktree add failed:\n${tailN(r.tail, 10)}`);
  // Keep task briefs out of commits even if the repo's .gitignore lacks it (shared by all worktrees).
  const common = (await git(repo.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).out.trim();
  const exclude = join(common, 'info', 'exclude');
  const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!cur.includes('.kit/handoff/')) { mkdirSync(join(exclude, '..'), { recursive: true }); appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.kit/handoff/\n`); }
  t.worktree = wt.replaceAll('\\', '/');
  if (!exists || !t.baseSha) t.baseSha = head.out.trim(); // a new branch always starts at today's base
  t.setupDone = false;
  event(t, `worktree ${t.worktree} on ${t.branch} from ${start}`);
  saveTicket(t);
}

// Remove worktree (and the local branch if never pushed). A repo's cleanup command runs first
// (e.g. unlinking junctions a plain recursive delete would follow); if it fails, nothing is removed.
export async function cleanup(id) {
  const cfg = loadConfig();
  const t = getTicket(id);
  const repo = cfg.repos[t.repo];
  if (t.worktree && existsSync(t.worktree)) {
    if (repo?.commands?.cleanup) {
      const r = await runCommand(repo.commands.cleanup, vars(t, repo), { cwd: dirname(t.worktree), log: logFile(t, 'cleanup'), timeoutMin: 5 });
      if (r.code) {
        updateTicket(id, (x) => { x.cleanupFailed = true; x.error = `cleanup failed; worktree kept:\n${tailN(r.tail, 10)}`; event(x, 'cleanup command failed; worktree kept'); });
        return;
      }
    }
    await git(repo.path, ['worktree', 'remove', '--force', t.worktree]);
  }
  if (!t.pr) await git(repo.path, ['branch', '-D', t.branch]);
  updateTicket(id, (x) => { x.worktree = ''; event(x, 'worktree removed'); });
}
