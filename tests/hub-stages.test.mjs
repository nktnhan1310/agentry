import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Real git (a bare "origin" + clone), real shell commands; only `claude` is a stub.
const tmp = mkdtempSync(join(tmpdir(), 'hub-stages-')).replaceAll('\\', '/');
process.env.KIT_HUB_DIR = join(tmp, 'hub');
process.env.KIT_CLAUDE_BIN = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
process.env.FAKE_CLAUDE_LOG = join(tmp, 'claude.log');
process.env.FAKE_VERDICTS = join(tmp, 'verdicts.txt');
for (const k of ['AUTHOR', 'COMMITTER']) { process.env[`GIT_${k}_NAME`] = 'Test'; process.env[`GIT_${k}_EMAIL`] = 'test@example.test'; }

const { createTicket, fill, getTicket, listTickets, loadConfig, readText, saveConfig, ticketFile, updateTicket } = await import('../hub/store.mjs');
const byKey = (k) => listTickets().find((x) => x.key === k); // ids are per repo (APP-1 …); tracker keys are stable
const { cleanup, runPipeline } = await import('../hub/pipeline.mjs');
const { actions } = await import('../hub/actions.mjs');
const { importCreate, importList, notifyTickets } = await import('../hub/stages.mjs');
const { outputs, vars, verdict } = await import('../hub/commands.mjs');
const { claudeArgs } = await import('../hub/engines.mjs');

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const script = (name, body) => { const p = join(tmp, name); writeFileSync(p, body); return `node "${p}"`; };
const calls = () => readFileSync(process.env.FAKE_CLAUDE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

git(tmp, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
git(tmp, 'clone', '-q', 'origin.git', 'app');
const clone = join(tmp, 'app');
writeFileSync(join(clone, 'README.md'), '# app\n');
git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'init'); git(clone, 'push', '-q', 'origin', 'main');
const ws = join(tmp, 'ws');
mkdirSync(ws);
writeFileSync(join(tmp, 'app-notes.md'), '# app notes\nWIKI-MARKER: tests run with npm test\n');

const commands = {
  evidence: script('ev.mjs', "import { writeFileSync } from 'node:fs';\nwriteFileSync(`${process.env.KIT_DIR}/evidence/shot.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47]));\nwriteFileSync(`${process.env.KIT_DIR}/evidence/result.txt`, '3 passed');\n"),
  publish: `${script('pub.mjs', "import { existsSync, rmSync, writeFileSync } from 'node:fs';\nconst flag = process.env.FAKE_PUBLISH_FAIL;\nif (flag && existsSync(flag)) { rmSync(flag); console.error('remote rejected'); process.exit(3); }\nwriteFileSync(`${process.env.KIT_DIR}/comment.md`, `Tested ${process.argv[2]} on ${process.argv[3]}`);\nconsole.log(`pr=https://example.test/pr/${process.argv[2]}`);\nconsole.log('comment=https://example.test/c/1');\n")} {ticket} {branch}`,
  notify: `${script('notify.mjs', "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.FAKE_NOTIFY_LOG, process.argv.slice(2).join(' ') + '\\n');\n")} {tickets}`,
  cleanup: 'node -e "process.exit(Number(process.env.FAIL_CLEANUP || 0))"',
};
process.env.FAKE_NOTIFY_LOG = join(tmp, 'notify.log');

const cfg = loadConfig();
for (const s of ['plan', 'code', 'review', 'test']) cfg.engines[s] = { tool: 'claude', model: '', agent: '' };
cfg.limits.claudeBudgetUsd = 0;
cfg.review.skipUnderLines = 0;
cfg.repos.app = {
  path: clone.replaceAll('\\', '/'), base: 'main', fetchBase: true, workspace: ws, wiki: [join(tmp, 'app-notes.md')],
  worktree: `${tmp}/wt/{ticket}/{repo}`, branch: '{ticket}', setup: '', verify: ['node -e "process.exit(0)"'], test: true,
  agents: { code: 'impl', review: 'rev', test: 'tr' }, commands,
};
cfg.repos.other = { path: clone.replaceAll('\\', '/'), base: 'main', commands: { notify: `${commands.notify} --other` } };
saveConfig(cfg);

const start = async (t) => { updateTicket(t.id, (x) => { x.status = 'running'; }); await runPipeline(t.id); return getTicket(t.id); };

test('placeholders, keys, verdicts, publish outputs, claude args', () => {
  assert.equal(fill('D:/wt/{ticket}/{repo} {x}', { ticket: 'KEY-1', repo: 'api' }), 'D:/wt/KEY-1/api {x}');
  assert.throws(() => vars({ id: 'T9', key: 'A;rm -rf' }), /unsafe ticket key/);
  assert.throws(() => createTicket({ repo: 'app', title: 'x', key: 'A B' }), /may only contain/);
  assert.equal(verdict('noise\nVERDICT: FAIL\n'), 'FAIL');
  assert.equal(verdict('OVERALL: PASS'), 'PASS');
  assert.equal(verdict('all good'), 'BLOCKED');
  assert.deepEqual(outputs('x\npr=https://p/1\ncomment=https://c/2\n'), { pr: 'https://p/1', comment: 'https://c/2' });
  const win = claudeArgs({ mode: 'run', agent: 'tr', addDirs: ['D:/wt/a'], platform: 'win32' });
  assert.equal(win[win.indexOf('--tools') + 1], 'Read,Grep,Glob,Bash,PowerShell', 'test stage: shells, no edits; PowerShell on Windows');
  assert.ok(win.includes('PowerShell(git * push*)') && win.includes('Bash(git * commit*)'), 'git -C <dir> push/commit denied');
  assert.deepEqual(win.slice(win.indexOf('--agent'), win.indexOf('--agent') + 4), ['--agent', 'tr', '--add-dir', 'D:/wt/a']);
  const linux = claudeArgs({ mode: 'write', platform: 'linux' });
  assert.equal(linux[linux.indexOf('--tools') + 1], 'Read,Grep,Glob,Edit,Write,Bash');
  assert.ok(!linux.some((a) => a.startsWith('PowerShell')) && !linux.includes('--agent'));
});

test('workspace ticket: worktree pattern, stage agents, wiki, test fail → fix → pass, evidence, publish', async () => {
  writeFileSync(process.env.FAKE_VERDICTS, 'FAIL\nPASS\n');
  const t = createTicket({ repo: 'app', title: 'Add feature', key: 'ABC-12', url: 'https://tracker.test/ABC-12', agents: { plan: 'pl' } });
  assert.equal(t.branch, 'ABC-12');
  assert.throws(() => createTicket({ repo: 'app', title: 'again', key: 'ABC-12' }), /already has an open ticket/);
  const d = await start(t);
  assert.equal(d.status, 'pr_open', d.error);
  assert.equal(d.pr, 'https://example.test/pr/ABC-12');
  assert.equal(d.comment, 'https://example.test/c/1');
  assert.equal(d.worktree, `${tmp}/wt/ABC-12/app`);
  assert.equal(d.resume, 'code');
  assert.match(readText(t.id, 'comment.md'), /Tested ABC-12 on ABC-12/);
  assert.match(readText(t.id, 'test.md'), /^VERDICT: PASS/);
  assert.match(readText(t.id, 'summary.md'), /### Tests[\s\S]*VERDICT: PASS/);
  assert.ok(existsSync(ticketFile(t.id, 'evidence/shot.png')) && existsSync(ticketFile(t.id, 'evidence/result.txt')));

  // 'other' = the finished-ticket report (engines.summary): no stage agent, runs in the worktree.
  const c = calls().filter((x) => x.kind !== 'other');
  assert.equal(calls().length - c.length, 1);
  assert.deepEqual(c.map((x) => x.kind), ['plan', 'code', 'review', 'test', 'code', 'review', 'test']);
  const agentOf = (x) => x.args[x.args.indexOf('--agent') + 1];
  assert.deepEqual(c.slice(0, 4).map(agentOf), ['pl', 'impl', 'rev', 'tr'], 'ticket agent beats repo agent');
  for (const x of c) {
    assert.ok(same(x.cwd, ws), 'Claude starts in the workspace');
    assert.equal(x.args[x.args.indexOf('--add-dir') + 1], d.worktree);
    assert.match(x.prompt, /Work only inside .*wt\/ABC-12\/app/);
    assert.match(x.prompt, /WIKI-MARKER/);
  }
  assert.match(c[4].prompt, new RegExp(`${d.worktree}/.kit/handoff/${t.id}.md`), 'absolute brief path in workspace mode');
  assert.match(readFileSync(`${d.worktree}/.kit/handoff/${t.id}.md`, 'utf8'), /tests failed[\s\S]*expected 2 lines/);
  assert.equal(readFileSync(`${d.worktree}/feature.txt`, 'utf8'), 'line\nline\n');
  assert.equal(git(clone, 'rev-list', '--count', 'main..ABC-12').stdout.trim(), '0', 'publish owns the commit');
  assert.notEqual(git(d.worktree, 'rev-parse', '--abbrev-ref', '@{u}').status, 0, 'no upstream to origin/main');
});

test('publish failure resumes at publish without recoding; in-flight origin branch refused', async () => {
  const flag = join(tmp, 'publish-fail');
  writeFileSync(flag, '1');
  process.env.FAKE_PUBLISH_FAIL = flag;
  const t = createTicket({ repo: 'app', title: 'Second', key: 'ABC-13' });
  let d = await start(t);
  assert.equal(d.status, 'failed');
  assert.match(d.error, /publish failed[\s\S]*remote rejected/);
  assert.equal(d.resume, 'publish');
  const codeRuns = calls().filter((x) => x.kind === 'code').length;
  actions.run(t.id);
  d = await start(t);
  assert.equal(d.status, 'pr_open', d.error);
  assert.equal(calls().filter((x) => x.kind === 'code').length, codeRuns, 'no recoding on resume');

  git(clone, 'push', '-q', 'origin', 'main:refs/heads/ABC-14');
  const busy = await start(createTicket({ repo: 'app', title: 'Busy', key: 'ABC-14' }));
  assert.equal(busy.status, 'failed');
  assert.match(busy.error, /already exists on origin/);
});

test('notify groups by command: one run per group with all keys', async () => {
  const o = createTicket({ repo: 'other', title: 'Other', key: 'OTH-1' });
  updateTicket(o.id, (x) => { x.status = 'pr_open'; x.pr = 'https://example.test/pr/OTH-1'; });
  const [a, b] = ['ABC-12', 'ABC-13'].map(byKey);
  assert.deepEqual([a.key, b.key], ['ABC-12', 'ABC-13']);
  const r = await notifyTickets([a.id, b.id, o.id, a.id]);
  assert.ok(r.ok, r.text);
  assert.deepEqual(readFileSync(process.env.FAKE_NOTIFY_LOG, 'utf8').trim().split('\n').sort(), ['ABC-12 ABC-13', 'OTH-1 --other']);
  assert.ok(getTicket(a.id).notifiedAt && getTicket(o.id).notifiedAt);
  const noPr = createTicket({ repo: 'other', title: 'No PR', key: 'OTH-2', status: 'backlog' });
  await assert.rejects(notifyTickets([noPr.id]), /has no PR yet/);
});

test('import: lists with manual/existing flags, creates only pickable keys, keeps valid agents', async () => {
  const items = [
    { key: 'NEW-1', title: 'New one', repo: 'app', url: 'https://tracker.test/NEW-1', agents: { code: 'impl', test: 'bad agent!', other: 'x' } },
    { key: 'MULTI-1', title: 'Two repos', repo: 'app', manual: 'multi-repo' },
    { key: 'A;B', title: 'Bad key', repo: 'app' },
    { key: 'ABC-12', title: 'Exists', repo: 'app' },
    { key: 'GONE-1', title: 'Unknown repo', repo: 'nope' },
  ];
  const c = loadConfig();
  c.import.command = script('import.mjs', `console.log('fetching…');\nconsole.log(${JSON.stringify(JSON.stringify({ tickets: items }))});\n`);
  saveConfig(c);
  const list = await importList();
  assert.deepEqual(list.map((e) => [e.key, e.manual, e.existing]), [
    ['NEW-1', '', ''], ['MULTI-1', 'multi-repo', ''], ['A;B', 'invalid key', ''], ['ABC-12', '', byKey('ABC-12').id], ['GONE-1', 'repo "nope" is not registered', ''],
  ]);
  const r = importCreate(['NEW-1', 'MULTI-1', 'ABC-12', 'ZZZ-9'], { backlog: true });
  assert.equal(r.created.length, 1);
  assert.equal(r.skipped.length, 3);
  const t = getTicket(r.created[0]);
  assert.deepEqual([t.key, t.status, t.url, t.branch], ['NEW-1', 'backlog', 'https://tracker.test/NEW-1', 'NEW-1']);
  assert.deepEqual(t.agents, { code: 'impl' });
});

test('cleanup: a failing cleanup command keeps the worktree', async () => {
  const t = byKey('ABC-13');
  process.env.FAIL_CLEANUP = '1';
  await cleanup(t.id);
  assert.ok(existsSync(t.worktree));
  assert.ok(getTicket(t.id).cleanupFailed);
  delete process.env.FAIL_CLEANUP;
  await cleanup(t.id);
  assert.ok(!existsSync(t.worktree));
  assert.equal(getTicket(t.id).worktree, '');
});
