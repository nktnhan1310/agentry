// Ticket pipeline: worktree → setup → plan → code ⇄ verify/fix → review ⇄ fix → local commit → STOP (status review).
// Push + PR only happen later, in approve(), after a human says so.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { detectCommands, scan } from '../lib/detect.mjs';
import { loadConfig as loadKitConfig } from '../lib/sync.mjs';
import { engine, shell } from './engines.mjs';
import { git, run } from './proc.mjs';
import { prompts } from './prompts.mjs';
import { event, getTicket, loadConfig, paths, readText, saveTicket, ticketFile, updateTicket, writeText } from './store.mjs';

const logFile = (t, name) => ticketFile(t.id, `logs/${name}.log`);
const tailN = (s, n) => s.split('\n').slice(-n).join('\n');

class Stop extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// Commands for setup/verify: explicit repo config wins, else detected from the repo.
export function repoCommands(repoCfg) {
  const kit = loadKitConfig(repoCfg.path);
  const info = scan(repoCfg.path, kit);
  const det = detectCommands(repoCfg.path, info);
  let setup = repoCfg.setup;
  if (setup === undefined) {
    const has = (f) => info.files.find((x) => basename(x) === f);
    const lock = has('pnpm-lock.yaml') || has('package-lock.json') || has('yarn.lock');
    const dir = lock && lock.includes('/') ? lock.slice(0, lock.lastIndexOf('/')) : '.';
    setup = lock?.endsWith('pnpm-lock.yaml') ? `pnpm install --frozen-lockfile --dir ${dir}`
      : lock?.endsWith('package-lock.json') ? `npm ci --prefix ${dir}`
      : lock?.endsWith('yarn.lock') ? `yarn --cwd ${dir} install --frozen-lockfile`
      : has('uv.lock') ? 'uv sync' : '';
  }
  const verify = repoCfg.verify || [...det.build, ...det.test];
  return { setup, verify };
}

async function ensureWorktree(t, repo) {
  if (t.worktree && existsSync(t.worktree)) return;
  const wt = join(paths.worktrees, t.repo, t.id);
  mkdirSync(join(wt, '..'), { recursive: true });
  const base = repo.base || 'main';
  const head = await git(repo.path, ['rev-parse', base]);
  if (head.code) throw new Stop('failed', `base "${base}" not found in ${repo.path}`);
  const exists = (await git(repo.path, ['rev-parse', '--verify', '--quiet', t.branch])).code === 0;
  const r = await git(repo.path, exists ? ['worktree', 'add', wt, t.branch] : ['worktree', 'add', '-b', t.branch, wt, base], { log: logFile(t, 'git') });
  if (r.code) throw new Stop('failed', `worktree add failed:\n${tailN(r.tail, 10)}`);
  // Keep task briefs out of commits even if the repo's .gitignore lacks it (shared by all worktrees).
  const common = (await git(repo.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).out.trim();
  const exclude = join(common, 'info', 'exclude');
  const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!cur.includes('.kit/handoff/')) { mkdirSync(join(exclude, '..'), { recursive: true }); appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.kit/handoff/\n`); }
  t.worktree = wt;
  t.baseSha = t.baseSha || head.out.trim();
  t.setupDone = false;
  event(t, `worktree ${wt} on ${t.branch}`);
  saveTicket(t);
}

async function verify(t, cmds, cfg, n) {
  if (!cmds.length) return { ok: true, report: 'no verify commands configured' };
  const lines = [];
  for (const c of cmds) {
    const r = await shell(c, { cwd: t.worktree, log: logFile(t, `verify-${n}`), timeoutMin: cfg.limits.stageTimeoutMin, ticketId: t.id });
    lines.push(`${r.code === 0 ? '✓' : '✗'} ${c}`);
    if (r.code !== 0) return { ok: false, report: lines.join('\n'), failure: `$ ${c}\n${tailN(r.tail, 60)}` };
  }
  return { ok: true, report: lines.join('\n') };
}

async function stagedDiff(t) {
  await git(t.worktree, ['add', '-A']);
  const stat = await git(t.worktree, ['diff', '--cached', '--stat', t.baseSha]);
  return stat.out.trim();
}

export async function runPipeline(id, onNotify) {
  const cfg = loadConfig();
  let t = getTicket(id);
  const repo = cfg.repos[t.repo];
  const step = (text) => { t = getTicket(id); event(t, text); saveTicket(t); };
  const cost = (usd) => { t = getTicket(id); t.cost.claudeUsd = +(t.cost.claudeUsd + usd).toFixed(4); saveTicket(t); };
  const stage = (s) => { t = getTicket(id); t.stage = s; saveTicket(t); };

  try {
    if (!repo) throw new Stop('failed', `repo "${t.repo}" not configured`);
    await ensureWorktree(t, repo);
    t = getTicket(id);
    const { setup, verify: verifyCmds } = repoCommands(repo);

    if (!t.setupDone && setup) {
      stage('setup');
      const r = await shell(setup, { cwd: t.worktree, log: logFile(t, 'setup'), timeoutMin: cfg.limits.stageTimeoutMin, ticketId: t.id });
      if (r.code) throw new Stop('failed', `setup failed: ${setup}\n${tailN(r.tail, 20)}`);
    }
    t = getTicket(id); t.setupDone = true; saveTicket(t);

    // PLAN
    const briefPath = join(t.worktree, '.kit', 'handoff', `${t.id}.md`);
    if (t.mode === 'quick' && !readText(t.id, 'brief.md')) {
      writeText(t.id, 'brief.md', prompts.quickBrief(t, verifyCmds));
      t = updateTicket(id, (x) => { x.resume = 'code'; event(x, 'quick mode: ticket used as brief (no plan step)'); });
    } else if (t.resume === 'plan' || !readText(t.id, 'brief.md')) {
      stage('plan');
      const e = cfg.engines.plan;
      const r = await engine(e.tool)(prompts.plan(t, verifyCmds), { cwd: t.worktree, model: e.model, write: false, log: logFile(t, 'plan'), timeoutMin: cfg.limits.stageTimeoutMin, ticketId: t.id, budgetUsd: cfg.limits.claudeBudgetUsd });
      cost(r.costUsd);
      if (!r.ok || !r.text) throw new Stop('failed', `plan step failed:\n${tailN(r.tail, 15)}`);
      if (/^NEEDS_INFO/.test(r.text)) {
        writeText(t.id, 'questions.md', r.text.replace(/^NEEDS_INFO\s*/, ''));
        throw new Stop('needs_info', r.text.replace(/^NEEDS_INFO\s*/, ''));
      }
      writeText(t.id, 'brief.md', r.text.replace(/^```(?:markdown)?\n|\n```$/g, '') + '\n');
      t = updateTicket(id, (x) => { x.resume = 'code'; event(x, 'plan written'); });
    }

    // CODE ⇄ VERIFY ⇄ REVIEW
    t = getTicket(id);
    let extra = t.feedback.length ? `\n## Changes requested by the human reviewer\n${t.feedback.at(-1)}\n` : '';
    let reviewRounds = 0;
    let verifyReport = '';
    let review = '';
    for (let i = 0; ; i++) {
      if (i > cfg.limits.fixIterations + cfg.limits.reviewRounds) throw new Stop('failed', `iteration limit reached; last problem:\n${extra.slice(0, 1500)}`);
      t = getTicket(id);
      t.iterations++; saveTicket(t);
      mkdirSync(join(briefPath, '..'), { recursive: true });
      writeFileSync(briefPath, readText(t.id, 'brief.md') + extra);

      stage('code');
      const e = cfg.engines.code;
      const msg = `Execute the task brief in .kit/handoff/${t.id}.md exactly. Follow its Constraints. Run its Acceptance commands. Never commit or push. Finish with the Report it asks for.`;
      const r = await engine(e.tool)(e.tool === 'claude' ? prompts.code(t) : msg, { cwd: t.worktree, model: e.model, write: true, log: logFile(t, `code-${t.iterations}`), timeoutMin: cfg.limits.stageTimeoutMin, ticketId: t.id, budgetUsd: cfg.limits.claudeBudgetUsd });
      cost(r.costUsd);
      if (!r.ok) throw new Stop('failed', `code step failed (${e.tool}):\n${tailN(r.tail, 15)}`);
      writeText(t.id, 'worker.md', r.text);

      stage('verify');
      const v = await verify(t, verifyCmds, cfg, t.iterations);
      verifyReport = v.report;
      if (!v.ok) {
        step(`verify failed (iteration ${t.iterations})`);
        extra = `\n## Fix (iteration ${t.iterations}): verification failed\nMake these pass. Don't weaken or delete tests unless they are wrong.\n~~~\n${v.failure}\n~~~\n`;
        continue;
      }

      const stat = await stagedDiff(t);
      if (!stat) throw new Stop('failed', 'worker made no changes');
      const numstat = (await git(t.worktree, ['diff', '--cached', '--numstat', t.baseSha])).out;
      const changed = numstat.split('\n').reduce((n, l) => n + (Number(l.split('\t')[0]) || 0) + (Number(l.split('\t')[1]) || 0), 0);

      if (cfg.limits.reviewRounds > 0 && changed < cfg.review.skipUnderLines) {
        review = `VERDICT: PASS\n(skipped: ${changed} changed lines < ${cfg.review.skipUnderLines}; verify passed)`;
      } else if (cfg.limits.reviewRounds > 0) {
        stage('review');
        const er = cfg.engines.review;
        const diff = (await git(t.worktree, ['diff', '--cached', '-U2', t.baseSha])).out;
        const inline = diff.length <= cfg.review.inlineDiffChars ? diff : '';
        const rv = await engine(er.tool)(prompts.review(t, stat, inline), { cwd: t.worktree, model: er.model, write: false, log: logFile(t, `review-${t.iterations}`), timeoutMin: cfg.limits.stageTimeoutMin, ticketId: t.id, budgetUsd: cfg.limits.claudeBudgetUsd });
        cost(rv.costUsd);
        review = rv.ok ? rv.text : `review step failed:\n${tailN(rv.tail, 10)}`;
        writeText(t.id, 'review.md', review);
        if (/^VERDICT:\s*BLOCKING/m.test(review) && reviewRounds < cfg.limits.reviewRounds) {
          reviewRounds++;
          step(`review blocking (round ${reviewRounds})`);
          extra = `\n## Fix: code review found blocking issues\nFix the BLOCKING items only.\n${review}\n`;
          continue;
        }
      }
      break;
    }

    // COMMIT locally (no push).
    stage('commit');
    t = getTicket(id);
    await git(t.worktree, ['add', '-A']);
    const msg = `${t.id}: ${t.title}${t.feedback.length ? ` (round ${t.feedback.length + 1})` : ''}`;
    const c = await git(t.worktree, ['commit', '-m', msg], { log: logFile(t, 'git') });
    if (c.code) throw new Stop('failed', `commit failed (hooks?):\n${tailN(c.tail, 15)}`);
    const stat = (await git(t.worktree, ['diff', '--stat', t.baseSha, 'HEAD'])).out.trim();
    const patch = (await git(t.worktree, ['diff', t.baseSha, 'HEAD'])).out;
    writeText(t.id, 'diff.patch', patch);
    writeText(t.id, 'summary.md', [`## ${t.id}: ${t.title}`, '', '### Verify', verifyReport, '', '### Changes', '```', stat, '```', '', '### Review', review || '(skipped)', ''].join('\n'));

    t = updateTicket(id, (x) => { x.status = 'review'; x.stage = ''; x.error = ''; event(x, 'ready for human review'); });
    await onNotify?.(t, 'review');
  } catch (err) {
    const status = err instanceof Stop ? err.status : 'failed';
    t = updateTicket(id, (x) => {
      if (x.status === 'running') x.status = x.cancel ? 'failed' : status;
      x.error = x.cancel ? 'cancelled' : String(err.message || err).slice(0, 3000);
      x.cancel = false;
      x.stage = '';
      x.resume = status === 'needs_info' ? 'plan' : x.resume;
      event(x, `${x.status}: ${x.error.split('\n')[0]}`);
    });
    await onNotify?.(t, t.status);
  }
}

// Human approved from phone/CLI: push branch and open the PR.
export async function approve(id, onNotify) {
  const cfg = loadConfig();
  let t = getTicket(id);
  const repo = cfg.repos[t.repo];
  try {
    const p = await git(t.worktree, ['push', '-u', 'origin', t.branch], { log: logFile(t, 'git') });
    if (p.code) throw new Error(`push failed:\n${tailN(p.tail, 10)}`);
    const bodyFile = ticketFile(t.id, 'pr-body.md');
    writeText(t.id, 'pr-body.md', prompts.prBody(t, readText(t.id, 'summary.md')));
    const args = ['pr', 'create', '--base', repo.base || 'main', '--head', t.branch, '--title', `${t.title}`, '--body-file', bodyFile];
    if (cfg.pr.draft) args.push('--draft');
    const pr = await run('gh', args, { cwd: t.worktree, log: logFile(t, 'git') });
    if (pr.code) throw new Error(`gh pr create failed:\n${tailN(pr.tail, 10)}`);
    t = updateTicket(id, (x) => { x.status = 'pr_open'; x.pr = pr.out.trim().split('\n').pop(); event(x, `PR ${x.pr}`); });
  } catch (e) {
    t = updateTicket(id, (x) => { x.status = 'review'; x.error = String(e.message); event(x, `approve failed: ${x.error.split('\n')[0]}`); });
  }
  await onNotify?.(t, t.status === 'pr_open' ? 'pr_open' : 'approve_failed');
}

// Remove worktree (and the local branch if never pushed).
export async function cleanup(id) {
  const cfg = loadConfig();
  const t = getTicket(id);
  const repo = cfg.repos[t.repo];
  if (t.worktree && existsSync(t.worktree)) await git(repo.path, ['worktree', 'remove', '--force', t.worktree]);
  if (!t.pr) await git(repo.path, ['branch', '-D', t.branch]);
  updateTicket(id, (x) => { x.worktree = ''; event(x, 'worktree removed'); });
}
