// Ticket pipeline: worktree → setup → plan → code ⇄ verify/fix → review ⇄ fix → [test ⇄ fix], then
//   with a publish command: [evidence] → publish (the command commits, pushes, opens the PR) → pr_open;
//   without: local commit → STOP (status review); push + PR happen later in approve(), after a human says so.
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { detectCommands, scan } from '../lib/detect.mjs';
import { loadConfig as loadKitConfig } from '../lib/sync.mjs';
import { outputs, runCommand, vars, verdict } from './commands.mjs';
import { engine, shell } from './engines.mjs';
import { git, run } from './proc.mjs';
import { context, prompts } from './prompts.mjs';
import { event, getTicket, loadConfig, readText, saveTicket, ticketFile, updateTicket, writeText } from './store.mjs';
import { ensureWorktree, Stop } from './worktree.mjs';

export { cleanup } from './worktree.mjs';

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
  const verify = repoCfg.verify || [...det.build, ...det.test];
  return { setup, verify };
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
  const cost = (usd) => { t = getTicket(id); t.cost.claudeUsd = +(t.cost.claudeUsd + usd).toFixed(4); saveTicket(t); };
  const stage = (s) => { t = getTicket(id); t.stage = s; saveTicket(t); };
  const limits = () => ({ timeoutMin: cfg.limits.stageTimeoutMin, ticketId: t.id });
  // One engine call for a stage. With a repo workspace, Claude starts there (its agents, rules and
  // hooks load) and reaches the worktree through --add-dir; the agent comes from ticket > repo > engine.
  const call = async (name, prompt, mode, logName) => {
    const e = cfg.engines[name];
    const isClaude = e.tool === 'claude';
    const ws = isClaude && repo.workspace;
    const agent = isClaude ? (t.agents?.[name] ?? repo.agents?.[name] ?? e.agent ?? '') : undefined;
    const r = await engine(e.tool)(prompt, { cwd: ws ? repo.workspace : t.worktree, addDirs: ws ? [t.worktree] : [], agent: agent || undefined, model: e.model, mode, log: logFile(t, logName), ...limits(), budgetUsd: cfg.limits.claudeBudgetUsd });
    cost(r.costUsd);
    return r;
  };

  try {
    if (!repo) throw new Stop('failed', `repo "${t.repo}" not configured`);
    await ensureWorktree(t, repo);
    t = getTicket(id);
    const { setup, verify: verifyCmds } = repoCommands(repo);
    const publishCmd = repo.commands?.publish;
    const ctx = context(t, repo);

    if (!t.setupDone && setup) {
      stage('setup');
      const r = await runCommand(setup, vars(t, repo), { cwd: t.worktree, log: logFile(t, 'setup'), ...limits() });
      if (r.code) throw new Stop('failed', `setup failed: ${setup}\n${tailN(r.tail, 20)}`);
    }
    t = getTicket(id); t.setupDone = true; saveTicket(t);

    let verifyReport = '';
    let review = '';
    let testReport = '';
    if (!['evidence', 'publish'].includes(t.resume)) {
      // PLAN
      const briefPath = join(t.worktree, '.kit', 'handoff', `${t.id}.md`);
      const brief = repo.workspace ? briefPath.replaceAll('\\', '/') : `.kit/handoff/${t.id}.md`;
      if (t.mode === 'quick' && !readText(t.id, 'brief.md')) {
        writeText(t.id, 'brief.md', prompts.quickBrief(t, verifyCmds));
        t = updateTicket(id, (x) => { x.resume = 'code'; event(x, 'quick mode: ticket used as brief (no plan step)'); });
      } else if (t.resume === 'plan' || !readText(t.id, 'brief.md')) {
        stage('plan');
        const r = await call('plan', prompts.plan(t, verifyCmds, ctx), 'read', 'plan');
        if (!r.ok || !r.text) throw new Stop('failed', `plan step failed:\n${tailN(r.tail, 15)}`);
        if (/^NEEDS_INFO/.test(r.text)) {
          writeText(t.id, 'questions.md', r.text.replace(/^NEEDS_INFO\s*/, ''));
          throw new Stop('needs_info', r.text.replace(/^NEEDS_INFO\s*/, ''));
        }
        writeText(t.id, 'brief.md', r.text.replace(/^```(?:markdown)?\n|\n```$/g, '') + '\n');
        t = updateTicket(id, (x) => { x.resume = 'code'; event(x, 'plan written'); });
      }

      // CODE ⇄ VERIFY ⇄ REVIEW ⇄ TEST
      t = getTicket(id);
      let extra = t.feedback.length ? `\n## Changes requested by the human reviewer\n${t.feedback.at(-1)}\n` : '';
      let reviewRounds = 0;
      for (let i = 0; ; i++) {
        if (i > cfg.limits.fixIterations + cfg.limits.reviewRounds) throw new Stop('failed', `iteration limit reached; last problem:\n${extra.slice(0, 1500)}`);
        t = getTicket(id);
        t.iterations++; saveTicket(t);
        mkdirSync(join(briefPath, '..'), { recursive: true });
        writeFileSync(briefPath, readText(t.id, 'brief.md') + extra);

        stage('code');
        const isClaude = cfg.engines.code.tool === 'claude';
        const r = await call('code', isClaude ? prompts.code(t, brief, ctx) : `Execute the task brief in ${brief} exactly. Follow its Constraints. Run its Acceptance commands. Never commit or push. Finish with the Report it asks for.`, 'write', `code-${t.iterations}`);
        if (!r.ok) throw new Stop('failed', `code step failed (${cfg.engines.code.tool}):\n${tailN(r.tail, 15)}`);
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
          const diff = (await git(t.worktree, ['diff', '--cached', '-U2', t.baseSha])).out;
          const rv = await call('review', prompts.review(t, stat, diff.length <= cfg.review.inlineDiffChars ? diff : '', ctx), 'read', `review-${t.iterations}`);
          review = rv.ok ? rv.text : `review step failed:\n${tailN(rv.tail, 10)}`;
          writeText(t.id, 'review.md', review);
          if (/^VERDICT:\s*BLOCKING/m.test(review) && reviewRounds < cfg.limits.reviewRounds) {
            reviewRounds++;
            step(`review blocking (round ${reviewRounds})`);
            extra = `\n## Fix: code review found blocking issues\nFix the BLOCKING items only.\n${review}\n`;
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
            step(`tests failed (iteration ${t.iterations})`);
            extra = `\n## Fix (iteration ${t.iterations}): tests failed\nMake the new failures pass. Don't weaken or delete tests unless they are wrong.\n${testReport}\n`;
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
        t = updateTicket(id, (x) => { x.resume = 'evidence'; });
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
    const stat = (await git(t.worktree, ['diff', '--stat', t.baseSha, 'HEAD'])).out.trim();
    writeText(t.id, 'diff.patch', (await git(t.worktree, ['diff', t.baseSha, 'HEAD'])).out);
    writeText(t.id, 'summary.md', summaryOf(t, verifyReport, stat, review, testReport));

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
