// End-to-end runs (Playwright) on a clean checkout of the base branch. Zero tokens: shell only.
// Each failing test becomes a bug ticket with its failure screenshot (Opus sees it once, at plan time);
// a later run where that test passes marks the fixed bug Verified.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scan } from '../lib/detect.mjs';
import { loadConfig as loadKitConfig } from '../lib/sync.mjs';
import { readJson, write } from '../lib/util.mjs';
import { checkImages, createWithImages, fromFile } from './attachments.mjs';
import { shell } from './engines.mjs';
import { git } from './proc.mjs';
import { event, HUB, listTickets, loadConfig, paths, updateTicket } from './store.mjs';

const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// repos.<name>.e2e overrides; cmd/dir default to the repo's playwright.config.* when there is one.
// maxBugs: more failures than this in one run usually share a cause (app down, bad env) → one grouped bug.
export function e2eConfig(r, info) {
  const x = r.e2e || {};
  let { cmd, dir } = x;
  if (!cmd && existsSync(r.path)) {
    const f = (info || scan(r.path, loadKitConfig(r.path))).files.find((p) => /(^|\/)playwright\.config\.(ts|js|mjs|cjs)$/.test(p));
    if (f) { cmd = 'npx playwright test'; dir = dir || (f.includes('/') ? dirname(f) : '.'); }
  }
  return { enabled: !!cmd && x.enabled !== false, cmd: cmd || '', dir: dir || '.', everyHours: Number(x.everyHours) || 0, inVerify: !!x.inVerify,
    fileBugs: x.fileBugs !== false, autoFix: !!x.autoFix, severity: x.severity || 'high', maxBugs: Number(x.maxBugs) || 5, detected: !x.cmd && !!cmd };
}

// For the ticket verify step: terse line reporter, so a failure costs the coder few tokens.
export const e2eVerifyCmd = (e) => `${e.dir && e.dir !== '.' ? `cd ${e.dir} && ` : ''}${e.cmd} --reporter=line`;

export const e2eDir = (repo) => join(HUB, 'e2e', repo);
export const e2eLog = (repo) => join(e2eDir(repo), 'run.log');
export function lastRun(repo) {
  const l = readJson(join(e2eDir(repo), 'last.json'), null);
  if (l?.status === 'running' && !alive(l.pid)) return { ...l, status: 'interrupted' };
  return l;
}
const saveRun = (repo, run) => write(join(e2eDir(repo), 'last.json'), `${JSON.stringify(run, null, 2)}\n`);

// Playwright JSON report → one entry per test × project. status: expected | unexpected | flaky | skipped.
export function parseReport(json) {
  const out = [];
  const walk = (suite, titles) => {
    for (const s of suite.suites || []) walk(s, [...titles, s.title].filter(Boolean));
    for (const spec of suite.specs || []) for (const test of spec.tests || []) {
      const results = test.results || [];
      const last = results.at(-1) || {};
      const err = last.error || last.errors?.[0] || {};
      const title = [...titles, spec.title].join(' › ');
      out.push({ key: `${spec.file}::${title}${test.projectName ? ` [${test.projectName}]` : ''}`, title, file: spec.file, line: spec.line, project: test.projectName || '',
        status: test.status, error: stripAnsi(err.message || err.value || '').trim(),
        screenshots: (last.attachments || []).filter((a) => a.path && /^image\//.test(a.contentType || '')).map((a) => a.path) });
    }
  };
  for (const s of json.suites || []) walk(s, []); // top level = one suite per file; its title is the file name
  return out;
}

// Clean, detached checkout of the latest base in its own worktree (never touches your working copy).
async function checkout(r, wt, log) {
  const base = r.base || 'main';
  let ref = base;
  if ((await git(r.path, ['remote', 'get-url', 'origin'])).code === 0) {
    await git(r.path, ['fetch', 'origin', base], { log });
    ref = `origin/${base}`;
  }
  if (!existsSync(wt)) {
    mkdirSync(dirname(wt), { recursive: true });
    const a = await git(r.path, ['worktree', 'add', '--detach', wt, ref], { log });
    if (a.code) throw new Error(`worktree add failed:\n${a.tail}`);
  } else {
    const c = await git(wt, ['checkout', '--detach', '--force', ref], { log });
    if (c.code) throw new Error(`checkout ${ref} failed:\n${c.tail}`);
    await git(wt, ['clean', '-fd'], { log }); // keeps ignored dirs (node_modules) for a faster setup
  }
  return (await git(wt, ['rev-parse', 'HEAD'])).out.trim();
}

const images = (paths) => paths.filter(existsSync).slice(0, 2).map(fromFile).filter((i) => { try { checkImages([i]); return true; } catch { return false; } });
const fence = (s, n) => `~~~\n${s.length > n ? `${s.slice(0, n)}\n…` : s || '(no error message)'}\n~~~`;

export async function runE2e(name, onNotify) {
  const cfg = loadConfig();
  const r = cfg.repos[name];
  if (!r) throw new Error(`unknown repo "${name}"`);
  const e = e2eConfig(r);
  if (!e.enabled) throw new Error('no e2e tests: add a playwright.config.* to the repo or set repos.<name>.e2e.cmd');
  if (lastRun(name)?.status === 'running') throw new Error(`an e2e run is already going for ${name}`);
  const log = e2eLog(name);
  const report = join(e2eDir(name), 'report.json');
  mkdirSync(e2eDir(name), { recursive: true });
  rmSync(log, { force: true }); rmSync(report, { force: true });
  const run = { at: new Date().toISOString(), pid: process.pid, status: 'running', base: r.base || 'main', sha: '', passed: 0, failed: 0, flaky: 0, skipped: 0, filed: [], still: [], verified: [], error: '' };
  saveRun(name, run);
  try {
    const wt = join(cfg.worktreeDir || paths.worktrees, name, '_e2e');
    run.sha = await checkout(r, wt, log);
    const { repoCommands } = await import('./pipeline.mjs'); // lazy: pipeline imports this module too
    const { setup } = repoCommands(r);
    if (setup) {
      const s = await shell(setup, { cwd: wt, log, timeoutMin: cfg.limits.stageTimeoutMin });
      if (s.code) throw new Error(`setup failed: ${setup}\n${s.tail.split('\n').slice(-15).join('\n')}`);
    }
    // CI=1: Playwright starts its own webServer and uses CI retries, so a flaky test shows as "flaky", not a bug.
    const res = await shell(`${e.cmd} --reporter=line,json`, { cwd: join(wt, e.dir), log, timeoutMin: cfg.limits.stageTimeoutMin,
      env: { CI: '1', PLAYWRIGHT_JSON_OUTPUT_NAME: report, PLAYWRIGHT_JSON_OUTPUT_FILE: report } });
    if (!existsSync(report)) throw new Error(`no JSON report (exit ${res.code}):\n${res.tail.split('\n').slice(-15).join('\n')}`);
    const json = JSON.parse(readFileSync(report, 'utf8'));
    const tests = parseReport(json);
    if (!tests.length && json.errors?.length) throw new Error(stripAnsi(json.errors.map((x) => x.message).join('\n')).slice(0, 1500));
    Object.assign(run, triage(name, r, e, tests, run));
    for (const id of run.filed) await onNotify?.(listTickets({ repo: name }).find((t) => t.id === id), 'bug');
    run.status = run.failed ? 'failed' : 'passed';
  } catch (err) {
    run.status = 'error'; run.error = String(err.message || err).slice(0, 3000);
  }
  saveRun(name, run);
  return run;
}

// Pure-ish: counts, files/dedupes bugs, verifies fixed ones. Exported for tests.
export function triage(name, r, e, tests, run) {
  const count = (s) => tests.filter((t) => t.status === s).length;
  const out = { passed: count('expected'), failed: count('unexpected'), flaky: count('flaky'), skipped: count('skipped'), filed: [], still: [], verified: [] };
  const mine = listTickets({ repo: name }).filter((t) => t.kind === 'bug' && t.source?.startsWith('e2e:'));
  const open = (key) => mine.find((t) => t.source === `e2e:${key}` && !['done', 'rejected'].includes(t.status));
  const fixed = (key) => mine.filter((t) => t.source === `e2e:${key}` && t.status === 'done').at(-1);
  const where = `${run.base} @ ${run.sha.slice(0, 7)}`;
  const file = (key, title, description, shots) => {
    const o = open(key);
    if (o) { updateTicket(o.id, (x) => event(x, `still failing in the e2e run on ${where}`)); out.still.push(o.id); return; }
    if (!e.fileBugs) return;
    const t = createWithImages({ repo: name, title: title.slice(0, 110), description, kind: 'bug', severity: e.severity, status: e.autoFix ? 'ready' : 'backlog', source: `e2e:${key}` }, images(shots));
    out.filed.push(t.id);
  };
  const failing = tests.filter((t) => t.status === 'unexpected');
  const repro = (f) => `Reproduce: ${e2eVerifyCmd(e).replace(/ --reporter=line$/, '')} ${f.file}:${f.line}${f.project ? ` --project=${f.project}` : ''}`;
  if (failing.length > e.maxBugs) {
    // Many at once almost always share one cause; one ticket = one plan call instead of N.
    const f = failing[0];
    file('*group*', `E2E: ${failing.length} tests failing on ${run.base}`,
      `Found by the e2e run on ${where}. ${failing.length} of ${tests.length} tests fail; likely one shared cause (app not starting, env, a broken shared component).\nFirst failure: ${f.file}:${f.line} — ${f.title}\n${fence(f.error, 1200)}\nAlso failing:\n${failing.slice(1, 15).map((x) => `- ${x.file}:${x.line} ${x.title}`).join('\n')}${failing.length > 15 ? `\n- … ${failing.length - 15} more` : ''}\n${repro(f)}`,
      f.screenshots);
  } else {
    for (const f of failing) {
      const prev = fixed(f.key);
      file(f.key, `E2E fails: ${f.title}`,
        `Found by the e2e run on ${where} (not caused by a hub ticket).${prev ? ` Regression: ${prev.id} fixed this before.` : ''}\nTest: ${f.file}:${f.line}${f.project ? ` [${f.project}]` : ''} — ${f.title}\nError:\n${fence(f.error, 1500)}\n${repro(f)}`,
        f.screenshots);
    }
  }
  // A fixed e2e bug whose test passes again is verified without anyone checking by hand.
  const byKey = new Map(tests.map((t) => [t.key, t]));
  for (const t of mine.filter((x) => x.status === 'done' && !x.verifiedAt)) {
    const key = t.source.slice(4);
    if (key === '*group*' ? !failing.length : byKey.get(key)?.status === 'expected') {
      updateTicket(t.id, (x) => { x.verifiedAt = new Date().toISOString(); x.verifiedBy = 'e2e'; event(x, `verified: e2e passes on ${where}`); });
      out.verified.push(t.id);
    }
  }
  return out;
}
