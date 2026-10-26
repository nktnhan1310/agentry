// Ticket pipeline: worktree → setup → plan → code ⇄ verify/fix → review ⇄ fix → [test ⇄ fix], then
//   with a publish command: [evidence] → publish (the command commits, pushes, opens the PR) → pr_open;
//   without: local commit → STOP (status review); push + PR happen later in approve(), after a human says so.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { detectCommands, scan } from '../lib/detect.mjs';
import { loadConfig as loadKitConfig } from '../lib/sync.mjs';
import { stageAttachments } from './attachments.mjs';
import { outputs, runCommand, vars, verdict } from './commands.mjs';
import { e2eConfig, e2eVerifyCmd } from './e2e.mjs';
import { engine, shell } from './engines.mjs';
import { git, run } from './proc.mjs';
import { context, prompts } from './prompts.mjs';
import { parseQuestions, renderQuestions } from './questions.mjs';
import { event, getTicket, loadConfig, readText, saveTicket, ticketFile, updateTicket, writeText } from './store.mjs';
import { ensureWorktree, Stop } from './worktree.mjs';

export { cleanup, ensureWorktree } from './worktree.mjs';

const logFile = (t, name) => ticketFile(t.id, `logs/${name}.log`);
const tailN = (s, n) => s.split('\n').slice(-n).join('\n');

// Commands for setup/verify: explicit repo config wins, else detected from the repo. `verify: []` = no build check.
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
  const verify = [...(repoCfg.verify || [...det.build, ...det.test])];
  const e2e = e2eConfig(repoCfg, info);
  if (e2e.enabled && e2e.inVerify) verify.push(e2eVerifyCmd(e2e)); // text-only failures back to the coder
  return { setup, verify };
}

// A ticket planned earlier can sit on an old base (e.g. the ticket it builds on merged since). Before its
// branch has any work, fast-forward it to the latest remote base; the plan step then re-plans if needed.
export async function refreshBase(t, repo) {
  if (t.iterations > 0 || !t.baseSha) return;
  const base = repo.base || 'main';
  const log = logFile(t, 'git');
  if ((await git(repo.path, ['remote', 'get-url', 'origin'])).code) return;
  if ((await git(t.worktree, ['fetch', 'origin', base], { log })).code) return;
  const head = (await git(t.worktree, ['rev-parse', `origin/${base}`])).out.trim();
  if (!head || head === t.baseSha) return;
  const own = (await git(t.worktree, ['rev-list', '--count', `${t.baseSha}..HEAD`])).out.trim();
  const dirty = (await git(t.worktree, ['status', '--porcelain'])).out.trim();
  if (own !== '0' || dirty) { updateTicket(t.id, (x) => event(x, `${base} moved, but the branch already has changes; not refreshing`)); return; }
  const ff = await git(t.worktree, ['merge', '--ff-only', `origin/${base}`], { log });
  if (ff.code) { updateTicket(t.id, (x) => event(x, `could not fast-forward to origin/${base}: ${tailN(ff.tail, 2)}`)); return; }
  updateTicket(t.id, (x) => {
    if (!x.planBase && readText(x.id, 'brief.md')) x.planBase = x.baseSha; // plans written before planBase existed
    x.baseSha = head; x.setupDone = false; // deps may have changed too
    event(x, `refreshed onto latest ${base} (${head.slice(0, 7)})`);
  });
}

// Failed attempts so far (verify failed, review blocking, tests failed, code step crashed/timed out); older tickets: from history.
export const failCount = (t) => t.failedAttempts ?? (t.history || []).filter((h) => /^(verify failed|review blocking|tests failed|failed: code step failed)/.test(h.text)).length;

// Escalation: after `after` failed attempts, code with the escalation engine (e.g. a local model first, then sonnet).
export function codeEngine(cfg, fails) {
  const x = cfg.engines.escalate;
  return x?.tool && x.after > 0 && fails >= x.after ? x : cfg.engines.code;
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

const summaryOf = (t, verifyReport, stat, review, test) => [`## ${t.key || t.id}: ${t.title}`, '', '### Verify', verifyReport, '', '### Changes', '```', stat, '```', '',
  ...(test ? ['### Tests', test, ''] : []), '### Review', review || '(skipped)', ''].join('\n');

export async function runPipeline(id, onNotify) {
  const cfg = loadConfig();
  let t = getTicket(id);
  const repo = cfg.repos[t.repo];
  const step = (text) => { t = getTicket(id); event(t, text); saveTicket(t); };
  // $ and tokens per step (plan/code/review/test/notes); tokens matter even when a local model makes $ zero.
  const cost = (r, name) => {
    t = getTicket(id);
    t.cost.claudeUsd = +(t.cost.claudeUsd + (r.costUsd || 0)).toFixed(4);
    const k = r.tokens || { in: 0, out: 0 };
    t.tokens = t.tokens || {};
    const s = t.tokens[name] || { in: 0, out: 0 };
    t.tokens[name] = { in: s.in + k.in, out: s.out + k.out };
    saveTicket(t);
  };
  const stage = (s) => { t = getTicket(id); t.stage = s; t.stageAt = new Date().toISOString(); saveTicket(t); };
  const limits = () => ({ timeoutMin: cfg.limits.stageTimeoutMin, ticketId: t.id });
  // One engine call for a stage. With a repo workspace, Claude starts there (its agents, rules and
  // hooks load) and reaches the worktree through --add-dir; the agent comes from ticket > repo > engine.
  // `e` overrides the stage's engine (code escalation).
  const call = async (name, prompt, mode, logName, e = cfg.engines[name]) => {
    const isClaude = e.tool === 'claude';
    const ws = isClaude && repo.workspace;
    const agent = isClaude ? (t.agents?.[name] ?? repo.agents?.[name] ?? e.agent ?? '') : undefined;
    const r = await engine(e.tool)(prompt, { cwd: ws ? repo.workspace : t.worktree, addDirs: ws ? [t.worktree] : [], agent: agent || undefined, model: e.model, mode, log: logFile(t, logName), ...limits(), budgetUsd: cfg.limits.claudeBudgetUsd });
    cost(r, name);
    return r;
  };
  // Two-audience report for Telegram / UI / PR. Best effort: never fails the ticket.
  const writeNotes = async (stat, verifyReport, review) => {
    const en = cfg.engines.summary;
    if (en?.tool !== 'claude') return;
    const r = await engine('claude')(prompts.notes(t, stat, readText(t.id, 'worker.md'), verifyReport, review), { cwd: t.worktree, model: en.model, write: false, log: logFile(t, 'notes'), timeoutMin: 5, ticketId: t.id, budgetUsd: cfg.limits.claudeBudgetUsd });
    cost(r, 'notes');
    if (r.ok && /## For everyone/.test(r.text)) writeText(t.id, 'notes.md', `${r.text.slice(r.text.indexOf('## For everyone')).trim()}\n`);
  };

  try {
    if (!repo) throw new Stop('failed', `repo "${t.repo}" not configured`);
    await ensureWorktree(t, repo);
    await refreshBase(getTicket(id), repo);
    t = getTicket(id);
    const { setup, verify: verifyCmds } = repoCommands(repo);
    const publishCmd = repo.commands?.publish;
    const ctx = context(t, repo);

    if (!t.setupDone && setup && !t.planOnly) { // planning only reads code; install deps when coding starts
      stage('setup');
      const r = await runCommand(setup, vars(t, repo), { cwd: t.worktree, log: logFile(t, 'setup'), ...limits() });
      if (r.code) throw new Stop('failed', `setup failed: ${setup}\n${tailN(r.tail, 20)}`);
    }
    t = getTicket(id); if (!t.planOnly) { t.setupDone = true; saveTicket(t); }

    let verifyReport = '';
    let review = '';
    let testReport = '';
    if (!['evidence', 'publish'].includes(t.resume)) {
      // PLAN (again if the brief was written against an older base and nobody edited it by hand)
      const briefPath = join(t.worktree, '.kit', 'handoff', `${t.id}.md`);
      const brief = repo.workspace ? briefPath.replaceAll('\\', '/') : `.kit/handoff/${t.id}.md`;
      const moved = t.mode !== 'quick' && readText(t.id, 'brief.md') && t.planBase && t.planBase !== t.baseSha && t.iterations === 0;
      if (moved && t.briefEdited) step('base moved since planning; keeping your edited plan');
      else if (moved) step(`base moved since planning (${t.planBase.slice(0, 7)} → ${t.baseSha.slice(0, 7)}): re-planning against the latest code`);
      // Bug screenshots → .kit/handoff/<id>/ (git-excluded); absolute when Claude starts in a workspace.
      const images = stageAttachments(t).map((p) => (repo.workspace ? `${t.worktree}/${p}` : p));
      if (t.mode === 'quick' && !readText(t.id, 'brief.md')) {
        writeText(t.id, 'brief.md', prompts.quickBrief(t, verifyCmds, images));
        t = updateTicket(id, (x) => { x.resume = 'code'; event(x, 'quick mode: ticket used as brief (no plan step)'); });
      } else if (t.resume === 'plan' || !readText(t.id, 'brief.md') || (moved && !t.briefEdited)) {
        stage('plan');
        const r = await call('plan', prompts.plan(t, verifyCmds, ctx, images), 'read', 'plan');
        if (!r.ok || !r.text) throw new Stop('failed', `plan step failed:\n${tailN(r.tail, 15)}`);
        if (/^NEEDS_INFO/.test(r.text)) {
          const body = r.text.replace(/^NEEDS_INFO\s*/, '');
          const qs = parseQuestions(body); // choices when the planner followed the JSON contract, else free text
          writeText(t.id, 'questions.json', qs ? JSON.stringify(qs, null, 2) : '');
          writeText(t.id, 'questions.md', qs ? renderQuestions(qs) : body);
          updateTicket(id, (x) => { x.picks = []; });
          throw new Stop('needs_info', qs ? renderQuestions(qs) : body);
        }
        writeText(t.id, 'brief.md', r.text.replace(/^```(?:markdown)?\n|\n```$/g, '') + '\n');
        t = updateTicket(id, (x) => { x.resume = 'code'; x.planBase = x.baseSha; x.briefEdited = false; event(x, 'plan written'); });
      }
      if (getTicket(id).planOnly) {
        t = updateTicket(id, (x) => { x.status = 'backlog'; x.stage = ''; x.planOnly = false; event(x, 'plan ready: review or edit it, then Run'); });
        return onNotify?.(t, 'planned');
      }

      // CODE ⇄ VERIFY ⇄ REVIEW ⇄ TEST
      t = getTicket(id);
      // Human change requests, plus what failed last time when this is a retry (cleared once a run commits).
      let extra = (t.feedback.length ? `\n## Changes requested by the human reviewer\n${t.feedback.at(-1)}\n` : '') + (t.lastFix || '');
      const fail = (fix, text) => { extra = fix; t = updateTicket(id, (x) => { x.failedAttempts = failCount(x) + 1; x.lastFix = fix; event(x, text); }); };
      let escalated = false;
      let reviewRounds = 0;
      for (let i = 0; ; i++) {
        if (i > cfg.limits.fixIterations + cfg.limits.reviewRounds) throw new Stop('failed', `iteration limit reached; last problem:\n${extra.slice(0, 1500)}`);
        t = getTicket(id);
        t.iterations++; saveTicket(t);
        mkdirSync(join(briefPath, '..'), { recursive: true });
        writeFileSync(briefPath, readText(t.id, 'brief.md') + extra);

        stage('code');
        const e = codeEngine(cfg, failCount(t));
        if (e !== cfg.engines.code && !escalated) { escalated = true; step(`escalated to ${e.tool} · ${e.model} after ${failCount(t)} failed attempt(s)`); }
        const msg = `Execute the task brief in ${brief} exactly. Follow its Constraints. Run its Acceptance commands. Never commit or push. Finish with the Report it asks for.`;
        const r = await call('code', e.tool === 'claude' ? prompts.code(t, brief, ctx) : msg, 'write', `code-${t.iterations}${e === cfg.engines.code ? '' : `-${e.model}`}`, e);
        if (!r.ok) {
          const why = `code step failed (${e.tool}${e.model ? ` · ${e.model}` : ''}):\n${tailN(r.tail, 15)}`;
          t = updateTicket(id, (x) => { x.failedAttempts = failCount(x) + 1; });
          // Escalation is due now (e.g. the local model is down): retry in this run instead of waiting for a human.
          if (codeEngine(cfg, failCount(t)) !== e) { step(why.split('\n')[0]); continue; }
          throw new Stop('failed', why);
        }
        writeText(t.id, 'worker.md', r.text);

        stage('verify');
        const v = await verify(t, verifyCmds, cfg, t.iterations);
        verifyReport = v.report;
        if (!v.ok) {
          fail(`\n## Fix (iteration ${t.iterations}): verification failed\nMake these pass. Don't weaken or delete tests unless they are wrong.\n~~~\n${v.failure}\n~~~\n`, `verify failed (iteration ${t.iterations})`);
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
          const diff = (await git(t.worktree, ['diff', '--cached', '-U2', t.baseSha])).out;
          const rv = await call('review', prompts.review(t, stat, diff.length <= cfg.review.inlineDiffChars ? diff : '', ctx), 'read', `review-${t.iterations}`);
          review = rv.ok ? rv.text : `review step failed:\n${tailN(rv.tail, 10)}`;
          writeText(t.id, 'review.md', review);
          if (/^VERDICT:\s*BLOCKING/m.test(review) && reviewRounds < cfg.limits.reviewRounds) {
            reviewRounds++;
            fail(`\n## Fix: code review found blocking issues\nFix the BLOCKING items only.\n${review}\n`, `review blocking (round ${reviewRounds})`);
            continue;
          }
        }

        if (repo.test) {
          stage('test');
          const tr = await call('test', prompts.test(t, stat, ctx), 'run', `test-${t.iterations}`);
          testReport = tr.ok ? tr.text : `VERDICT: BLOCKED\ntest step failed:\n${tailN(tr.tail, 10)}`;
          writeText(t.id, 'test.md', testReport);
          const tv = verdict(testReport);
          if (tv === 'BLOCKED') throw new Stop('failed', `tests could not run:\n${testReport.slice(0, 1500)}`);
          if (tv === 'FAIL') {
            fail(`\n## Fix (iteration ${t.iterations}): tests failed\nMake the new failures pass. Don't weaken or delete tests unless they are wrong.\n${testReport}\n`, `tests failed (iteration ${t.iterations})`);
            continue;
          }
        }
        break;
      }
    }

    if (publishCmd) {
      t = getTicket(id);
      if (!['evidence', 'publish'].includes(t.resume)) {
        const stat = await stagedDiff(t);
        writeText(t.id, 'diff.patch', (await git(t.worktree, ['diff', '--cached', t.baseSha])).out);
        writeText(t.id, 'summary.md', summaryOf(t, verifyReport, stat, review, testReport));
        await writeNotes(stat, verifyReport, review);
        t = updateTicket(id, (x) => { x.resume = 'evidence'; x.lastFix = ''; });
      }
      if (t.resume === 'evidence' && repo.commands.evidence) {
        stage('evidence');
        mkdirSync(ticketFile(t.id, 'evidence'), { recursive: true });
        const r = await runCommand(repo.commands.evidence, vars(t, repo), { cwd: t.worktree, log: logFile(t, 'evidence'), ...limits() });
        if (r.code) throw new Stop('failed', `evidence failed:\n${tailN(r.tail, 20)}`);
        step('evidence captured');
      }
      t = updateTicket(id, (x) => { x.resume = 'publish'; });
      stage('publish');
      const p = await runCommand(publishCmd, vars(t, repo), { cwd: t.worktree, log: logFile(t, 'publish'), ...limits() });
      if (p.code) throw new Stop('failed', `publish failed:\n${tailN(p.tail, 20)}`);
      const o = outputs(p.out);
      t = updateTicket(id, (x) => {
        x.status = 'pr_open'; x.stage = ''; x.error = ''; x.resume = 'code';
        if (o.pr) x.pr = o.pr;
        if (o.comment) x.comment = o.comment;
        event(x, `published${o.pr ? `: ${o.pr}` : ''}`);
      });
      await onNotify?.(t, 'pr_open');
      return;
    }

    // COMMIT locally (no push).
    stage('commit');
    t = getTicket(id);
    await git(t.worktree, ['add', '-A']);
    const msg = `${t.id}: ${t.title}${t.feedback.length ? ` (round ${t.feedback.length + 1})` : ''}`;
    const c = await git(t.worktree, ['commit', '-m', msg], { log: logFile(t, 'git') });
    if (c.code) throw new Stop('failed', `commit failed (hooks?):\n${tailN(c.tail, 15)}`);
    t = updateTicket(id, (x) => { x.lastFix = ''; });
    const stat = (await git(t.worktree, ['diff', '--stat', t.baseSha, 'HEAD'])).out.trim();
    writeText(t.id, 'diff.patch', (await git(t.worktree, ['diff', t.baseSha, 'HEAD'])).out);
    writeText(t.id, 'summary.md', summaryOf(t, verifyReport, stat, review, testReport));
    await writeNotes(stat, verifyReport, review);

    // Autopilot: skip the human gate when the repo allows it and checks + review passed.
    // A Stop that lands after the commit (e.g. during the report) still blocks autopilot: a human looks first.
    const passed = cfg.limits.reviewRounds === 0 || /^VERDICT:\s*PASS/m.test(review);
    const stopped = !!getTicket(id).cancel;
    const auto = !!repo.autoApprove && passed && !stopped;
    t = updateTicket(id, (x) => {
      x.status = auto ? 'approved' : 'review'; x.stage = ''; x.error = ''; x.cancel = false;
      event(x, auto ? 'checks passed → auto-approved (push + PR)' : stopped ? 'stop requested after the commit: waiting for your review (not auto-approved)' : 'ready for human review');
    });
    if (!auto) await onNotify?.(t, 'review'); // auto: approve() sends the report with the PR link
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
    writeText(t.id, 'pr-body.md', prompts.prBody(t, readText(t.id, 'summary.md'), readText(t.id, 'notes.md')));
    const args = ['pr', 'create', '--base', repo.base || 'main', '--head', t.branch, '--title', `${t.title}`, '--body-file', bodyFile];
    if (cfg.pr.draft) args.push('--draft');
    const pr = await run('gh', args, { cwd: t.worktree, log: logFile(t, 'git') });
    // After "request changes" on an open PR the push updates it; gh then reports it already exists.
    const existing = pr.code && /already exists/.test(pr.tail) ? (pr.tail.match(/https:\/\/\S+\/pull\/\d+/) || [])[0] : '';
    if (pr.code && !existing) throw new Error(`gh pr create failed:\n${tailN(pr.tail, 10)}`);
    const url = existing || pr.out.trim().split('\n').pop();
    t = updateTicket(id, (x) => { x.status = 'pr_open'; x.pr = url; x.error = ''; event(x, existing ? `PR updated ${url}` : `PR ${url}`); });
    if (repo.autoMerge) return autoMerge(id, repo, onNotify);
  } catch (e) {
    t = updateTicket(id, (x) => { x.status = 'review'; x.error = String(e.message); event(x, `approve failed: ${x.error.split('\n')[0]}`); });
  }
  await onNotify?.(t, t.status === 'pr_open' ? 'pr_open' : 'approve_failed');
}

// state: OPEN | MERGED | CLOSED · mergeable: MERGEABLE | CONFLICTING | UNKNOWN (GitHub computes it lazily).
async function prInfo(repo, url) {
  const r = await run('gh', ['pr', 'view', url, '--json', 'state,mergeable,baseRefOid,headRefOid'], { cwd: repo.path });
  try { return JSON.parse(r.out); } catch { return {}; }
}
const prState = async (repo, url) => (await prInfo(repo, url)).state || '';

// Repo opted in: let GitHub merge once checks pass (--auto); without branch protection that is refused, so merge now.
async function autoMerge(id, repo, onNotify) {
  let t = getTicket(id);
  const method = `--${['merge', 'rebase'].includes(repo.mergeMethod) ? repo.mergeMethod : 'squash'}`;
  const log = logFile(t, 'git');
  let m = await run('gh', ['pr', 'merge', t.pr, method, '--auto'], { cwd: repo.path, log });
  if (m.code) m = await run('gh', ['pr', 'merge', t.pr, method], { cwd: repo.path, log });
  if (m.code) {
    t = updateTicket(id, (x) => { x.autoMerge = 'failed'; x.error = `auto-merge failed:\n${tailN(m.tail, 8)}`; event(x, 'auto-merge failed; merge it on GitHub'); });
    return onNotify?.(t, 'pr_open');
  }
  if (await prState(repo, t.pr) === 'MERGED') {
    t = updateTicket(id, (x) => { x.status = 'done'; x.autoMerge = 'merged'; event(x, `auto-merged (${method.slice(2)})`); });
    return onNotify?.(t, 'merged');
  }
  t = updateTicket(id, (x) => { x.autoMerge = 'pending'; event(x, 'auto-merge enabled: merges when checks pass'); });
  return onNotify?.(t, 'pr_open');
}

// Daemon polls tickets waiting on (or refused by) auto-merge. A PR that conflicts with its base gets the base
// merged in and the conflicts resolved, then the merge is retried.
export async function checkMerged(id, onNotify, resolve = resolveConflicts) {
  const t = getTicket(id);
  const cfg = loadConfig();
  const repo = cfg.repos[t.repo];
  if (!repo || !t.pr) return;
  const pr = await prInfo(repo, t.pr);
  if (pr.state === 'MERGED') return onNotify?.(updateTicket(id, (x) => { x.status = 'done'; x.autoMerge = 'merged'; event(x, 'PR merged'); }), 'merged');
  if (pr.state === 'CLOSED') { updateTicket(id, (x) => { x.autoMerge = ''; event(x, 'PR closed without merging'); }); return; }
  if (!shouldResolve(t, repo, cfg, pr)) return;
  updateTicket(id, (x) => { x.conflictTried = conflictKey(pr); x.autoMerge = x.autoMerge || 'failed'; event(x, `PR conflicts with ${repo.base || 'main'}: resolving`); });
  if (await resolve(id, onNotify)) await autoMerge(id, repo, onNotify);
}

// One attempt per base/head pair: a failed attempt waits for the base (or the PR) to move before trying again.
const conflictKey = (pr) => `${pr.baseRefOid}..${pr.headRefOid}`;
export const shouldResolve = (t, repo, cfg, pr) => pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING' && !!repo.autoMerge
  && !!cfg.engines.resolve?.tool && cfg.engines.resolve.tool !== 'off' && t.conflictTried !== conflictKey(pr);

const MARKER = /^(<{7}|>{7})( |$)/m;
export const unresolved = (wt, files) => files.filter((f) => existsSync(join(wt, f)) && MARKER.test(readFileSync(join(wt, f), 'utf8')));

// Merge origin/<base> into the PR branch; engines.resolve fixes the conflicts; verify; commit the merge; push (no force).
// Returns true once pushed. On failure the merge is aborted and the ticket stays pr_open with the reason.
export async function resolveConflicts(id, onNotify, agent) {
  const cfg = loadConfig();
  let t = getTicket(id);
  const repo = cfg.repos[t.repo];
  const base = repo.base || 'main';
  const log = logFile(t, 'git');
  const stage = (s) => { t = updateTicket(id, (x) => { x.stage = s; x.stageAt = new Date().toISOString(); }); };
  const fail = async (why) => {
    if (t.worktree) await git(t.worktree, ['merge', '--abort'], { log });
    t = updateTicket(id, (x) => { x.stage = ''; x.error = `conflict resolution failed: ${why}`; event(x, `could not resolve conflicts with ${base}: ${why.split('\n')[0]}; resolve them on GitHub`); });
    await onNotify?.(t, 'conflict');
    return false;
  };
  try {
    await ensureWorktree(t, repo);
    t = getTicket(id);
    await git(t.worktree, ['merge', '--abort']); // leftover from a run cut short by a restart
    if ((await git(t.worktree, ['status', '--porcelain'])).out.trim()) return fail('the worktree has uncommitted changes');
    for (const ref of [base, t.branch]) {
      const f = await git(t.worktree, ['fetch', 'origin', ref], { log });
      if (f.code) return fail(`fetch origin ${ref} failed:\n${tailN(f.tail, 5)}`);
    }
    // Commits pushed to the PR on GitHub come first.
    const ff = await git(t.worktree, ['merge', '--ff-only', `origin/${t.branch}`], { log });
    if (ff.code) return fail(`local ${t.branch} has diverged from origin`);

    stage('resolve');
    const m = await git(t.worktree, ['merge', '--no-ff', '--no-commit', `origin/${base}`], { log });
    const files = (await git(t.worktree, ['diff', '--name-only', '--diff-filter=U'])).out.split('\n').map((s) => s.trim()).filter(Boolean);
    if (m.code && !files.length) return fail(`git merge origin/${base} failed:\n${tailN(m.tail, 8)}`);
    const merging = (await git(t.worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0;

    if (merging) {
      const { setup, verify: verifyCmds } = repoCommands(repo);
      const e = cfg.engines.resolve;
      let extra = '';
      let setupDone = false;
      for (let i = 1; ; i++) {
        if (i > cfg.limits.fixIterations + 1) return fail(`gave up after ${i - 1} attempt(s); last problem:\n${extra.slice(0, 1500)}`);
        if (files.length) {
          const r = await (agent || engine(e.tool))(prompts.resolve(t, base, files, extra), { cwd: t.worktree, model: e.model, write: true, log: logFile(t, `resolve-${i}`), timeoutMin: cfg.limits.stageTimeoutMin, ticketId: t.id, budgetUsd: cfg.limits.claudeBudgetUsd });
          t = updateTicket(id, (x) => {
            x.cost.claudeUsd = +(x.cost.claudeUsd + (r.costUsd || 0)).toFixed(4);
            const k = r.tokens || { in: 0, out: 0 }, s = x.tokens?.resolve || { in: 0, out: 0 };
            x.tokens = { ...x.tokens, resolve: { in: s.in + k.in, out: s.out + k.out } };
          });
          if (!r.ok) return fail(`${e.tool}${e.model ? ` · ${e.model}` : ''} failed:\n${tailN(r.tail, 10)}`);
          const left = unresolved(t.worktree, files);
          if (left.length) { extra = `\n\n## Still unresolved (attempt ${i})\nConflict markers remain in: ${left.join(', ')}`; continue; }
        }
        if (setup && !setupDone) { // the base may have changed dependencies
          stage('setup');
          const s = await runCommand(setup, vars(t, repo), { cwd: t.worktree, log: logFile(t, 'setup'), timeoutMin: cfg.limits.stageTimeoutMin, ticketId: t.id });
          if (s.code) return fail(`setup failed: ${setup}\n${tailN(s.tail, 10)}`);
          setupDone = true;
        }
        stage('verify');
        const v = await verify(t, verifyCmds, cfg, `resolve-${i}`);
        if (v.ok) break;
        if (!files.length) return fail(`verification failed after a clean merge of ${base}:\n${v.failure.slice(0, 1500)}`);
        extra = `\n\n## Verification failed after your resolution (attempt ${i})\nFix it in the merged files; don't weaken or delete tests unless they are wrong.\n~~~\n${v.failure}\n~~~`;
        stage('resolve');
      }
      await git(t.worktree, ['add', '-A']);
      const c = await git(t.worktree, ['commit', '--no-edit'], { log });
      if (c.code) return fail(`commit failed (hooks?):\n${tailN(c.tail, 8)}`);
    }
    const p = await git(t.worktree, ['push', 'origin', t.branch], { log });
    if (p.code) return fail(`push failed:\n${tailN(p.tail, 8)}`);
    t = updateTicket(id, (x) => {
      x.stage = ''; x.error = '';
      event(x, files.length ? `merged ${base} and resolved conflicts in ${files.length} file(s): ${files.join(', ')}; pushed` : `merged ${base} (no conflicts locally); pushed`);
    });
    return true;
  } catch (e) {
    return fail(String(e.message || e));
  }
}
