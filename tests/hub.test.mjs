import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.KIT_HUB_DIR = mkdtempSync(join(tmpdir(), 'hub-'));
const { createTicket, listTickets, loadConfig, normId, repoPrefix, saveConfig, saveTicket, updateTicket, writeText } = await import('../hub/store.mjs');
const { actions } = await import('../hub/actions.mjs');
const { card, parseNew } = await import('../hub/telegram.mjs');

const cfg = loadConfig();
cfg.repos = { web: { path: '/tmp/web', base: 'main' }, api: { path: '/tmp/api', base: 'main' } };
saveConfig(cfg);

test('ticket state machine guards transitions', () => {
  const t = createTicket({ repo: 'web', title: 'Add login', status: 'backlog' });
  assert.equal(t.id, 'WEB-1');
  assert.throws(() => actions.approve('web-1'), /needs: review/);
  assert.equal(actions.run('web1').status, 'ready');
  updateTicket('WEB-1', (x) => { x.status = 'review'; });
  assert.equal(actions.changes('web-1', 'rename button').status, 'ready');
  const t2 = actions.get('web-1');
  assert.equal(t2.resume, 'code');
  assert.deepEqual(t2.feedback, ['rename button']);
  updateTicket('WEB-1', (x) => { x.status = 'needs_info'; });
  writeText('WEB-1', 'questions.md', '1. OAuth or password?');
  const t3 = actions.answer('web-1', 'password');
  assert.equal(t3.resume, 'plan');
  assert.match(t3.answers[0], /OAuth or password\?[\s\S]*password/);
  assert.throws(() => createTicket({ repo: 'nope', title: 'x' }), /unknown repo/);
});

test('ticket ids are per repo, legacy T ids still resolve', () => {
  assert.deepEqual(['pixtune', 'saas-core', 'binance-futures-monitor', '1-x', '...'].map((n) => repoPrefix(n)), ['PIX', 'SC', 'BFM', 'T', 'T']);
  assert.equal(repoPrefix('pixtune', { prefix: 'PT' }), 'PT');
  assert.deepEqual(['37', 't37', 'pix1', 'Pix-12', 'SC10', 'x/../y'].map(normId), ['T37', 'T37', 'PIX-1', 'PIX-12', 'SC-10', 'X/../Y']);
  const a = createTicket({ repo: 'api', title: 'one', status: 'backlog' });
  const b = createTicket({ repo: 'api', title: 'two', status: 'backlog' });
  assert.deepEqual([a.id, b.id, b.branch], ['API-1', 'API-2', 'kit/API-2-two']);
  saveTicket({ ...a, id: 'T9', createdAt: '2000-01-01T00:00:00.000Z' }); // legacy id, oldest
  assert.deepEqual(listTickets({ repo: 'api' }).map((t) => t.id), ['T9', 'API-1', 'API-2']);
  assert.equal(actions.get('9').title, 'one');
});

test('hub add accepts a repo path, registers it, reads --desc-file', async () => {
  const { hub } = await import('../hub/cli.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  mkdirSync(join(repo, '.kit', 'handoff'), { recursive: true });
  const draft = join(repo, '.kit', 'handoff', 'new-ticket.md');
  writeFileSync(draft, 'Goal: x\n');
  const out = await hub(['add', repo, 'Do', 'thing'], { 'desc-file': draft, quick: true });
  assert.match(out, /repo "repo-\w+"[\s\S]*[A-Z][A-Z0-9]*-\d+ ready \(quick\): Do thing/);
  assert.ok(!existsSync(draft));
  const t = listTickets().at(-1);
  assert.equal(t.description, 'Goal: x');
  assert.match(await hub(['add', repo, 'Again'], {}), /^[A-Z][A-Z0-9]*-\d+ ready: Again/); // second time: matched, not re-registered
  assert.equal(await hub(['config', 'engines.plan.model'], {}), '"opus"');
  assert.equal(await hub(['config', 'limits.maxParallel', '2'], {}), 'limits.maxParallel = 2');
  assert.equal(loadConfig().limits.maxParallel, 2);
});

test('telegram parsing and cards', () => {
  assert.deepEqual(parseNew('/new api Fix 500 on /users\nstack trace here', loadConfig()), { repo: 'api', title: 'Fix 500 on /users', description: 'stack trace here' });
  assert.throws(() => parseNew('/new Fix it', loadConfig()), /which repo/);
  const t = createTicket({ repo: 'web', title: 'Dark <mode>', mode: 'quick' });
  updateTicket(t.id, (x) => { x.status = 'review'; x.worktree = 'D:/wt'; });
  writeText(t.id, 'summary.md', '## x\n### Verify\n✓ pnpm test');
  const c = card(actions.get(t.id));
  assert.match(c.text, /Dark &lt;mode&gt;/);
  const buttons = c.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.deepEqual(buttons, [`diff:${t.id}`, `approve:${t.id}`, `changes:${t.id}`, `reject:${t.id}`]);
  assert.ok(c.text.length <= 4000);

  // Finished ticket: plain-language report first, then engineer details pulled from summary.md.
  updateTicket(t.id, (x) => { x.status = 'pr_open'; x.pr = 'https://github.com/o/r/pull/7'; x.description = 'Users asked for it'; });
  writeText(t.id, 'summary.md', '## x\n### Verify\n✓ pnpm test\n\n### Changes\n```\n a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n```\n\n### Review\nVERDICT: PASS\n');
  writeText(t.id, 'notes.md', '## For everyone\nThe app now has a dark mode.\n## For engineers\n- Adds a theme token set\n');
  const r = card(actions.get(t.id)).text;
  assert.match(r, /for everyone<\/b>\nThe app now has a dark mode\./);
  assert.match(r, /- Adds a theme token set/);
  assert.match(r, /Checks: ✓ pnpm test/);
  assert.match(r, /Review: passed/);
  assert.match(r, /1 file changed/);
  assert.match(r, /PR: https:\/\/github\.com\/o\/r\/pull\/7/);
});

test('ollama/ models route claude to local Ollama', async () => {
  const { localModel } = await import('../hub/engines.mjs');
  assert.equal(localModel('opus'), null);
  const l = localModel('ollama/qwen3:8b-32k');
  assert.equal(l.model, 'qwen3:8b-32k');
  assert.equal(l.env.ANTHROPIC_BASE_URL, 'http://localhost:11434');
  assert.equal(l.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'qwen3:8b-32k');
});

test('plan only: action queues a plan-only run; run clears it', () => {
  const t = createTicket({ repo: 'api', title: 'Add rate limiter', status: 'backlog' });
  const p = actions.plan(t.id);
  assert.deepEqual([p.status, p.resume, p.planOnly], ['ready', 'plan', true]);
  assert.equal(actions.stop(t.id).planOnly, false); // unqueued
  assert.equal(actions.run(t.id).planOnly, false);
  assert.throws(() => actions.plan(t.id), /needs: backlog \| failed/);
});

test('plan files: numbered headings and bold roadmap items with a Goal become tickets', async () => {
  const { parsePlan, parseItems } = await import('../hub/plans.mjs');
  const mvp = parsePlan('# MVP\n\n## 1. REST client\nGoal: fetch data.\nAcceptance: tests pass.\n\n## 2. Store — superseded by 2.1\nGoal: x\n\n## Notes\nnot a ticket\n', '.wiki/plans/mvp.md');
  assert.deepEqual(mvp.map((i) => [i.key, i.title, i.superseded]), [['1', 'REST client', false], ['2', 'Store', true]]);
  assert.equal(mvp[0].source, '.wiki/plans/mvp.md#1');
  assert.match(mvp[0].description, /Acceptance: tests pass\.[\s\S]*Source: \.wiki\/plans\/mvp\.md item 1/);
  const road = parsePlan('## Phase 1 — Core\nintro text\n\n**1.8 Rate-limit governor** → mvp 1\nGoal: back off.\nAcceptance: headers.\n\n### 4.1 Prose section\nno goal here\n', 'r.md');
  assert.deepEqual(road.map((i) => [i.key, i.title]), [['1.8', 'Rate-limit governor']]);
  assert.match(road[0].description, /Depends on: mvp 1/);
  const oneLine = parsePlan('**4.1 State features** → 1.9 · Acceptance: pure fn; tests.\n**3.1 Sector map** → —\nAcceptance: yaml loader.\n**5.1 Sources** · Acceptance: RSS.\n', 'r.md');
  assert.deepEqual(oneLine.map((i) => [i.key, i.title]), [['4.1', 'State features'], ['3.1', 'Sector map'], ['5.1', 'Sources']]);
  assert.match(oneLine[0].description, /^Acceptance: pure fn; tests\.\n\nDepends on: 1\.9/);
  assert.doesNotMatch(oneLine[1].description, /Depends on/);
  assert.deepEqual(parseItems('Here:\n[{"title":"A","description":"Goal: a"},{"x":1}]'), [{ title: 'A', description: 'Goal: a' }]);
});

test('planner questions become choices (UI + Telegram), with a free-text fallback', async () => {
  const { parseQuestions, renderQuestions, formatAnswers } = await import('../hub/questions.mjs');
  const qs = parseQuestions('[{"q":"Where does rate limiting go?","options":["Wait for T1","Standalone module"],"default":1},{"q":"Docs scope?","options":["Only this branch"],"default":9},{"bad":1}]');
  assert.deepEqual(qs.map((x) => [x.q, x.options.length, x.default]), [['Where does rate limiting go?', 2, 1], ['Docs scope?', 1, 0]]);
  assert.equal(parseQuestions('1. Plain question?'), null);
  assert.match(renderQuestions(qs), /1\. Where does rate limiting go\?\n {3}a\) Wait for T1\n {3}b\) Standalone module {2}\(suggested\)/);
  assert.equal(formatAnswers(qs, [0, 'my own'], 'ship it'), '1. Where does rate limiting go?\n→ Wait for T1\n2. Docs scope?\n→ my own\nAlso: ship it');
  assert.match(formatAnswers(qs, [null]), /→ Standalone module/); // unpicked = suggested

  const t = createTicket({ repo: 'web', title: 'Harden', status: 'backlog' });
  updateTicket(t.id, (x) => { x.status = 'needs_info'; x.picks = [0]; });
  writeText(t.id, 'questions.md', renderQuestions(qs));
  writeText(t.id, 'questions.json', JSON.stringify(qs));
  const c = card(actions.get(t.id));
  const labels = c.reply_markup.inline_keyboard.flat();
  assert.deepEqual(labels.filter((b) => b.callback_data.startsWith('pick:')).map((b) => b.text.split(' · ')[0]), ['✅ 1a', '▫️ 1b', '✅ 2a']);
  assert.ok(labels.some((b) => b.callback_data === `send:${t.id}`));
  assert.match(c.text, /Tap your choice/);
});

test('reopen: a rejected ticket returns to the backlog and will branch fresh', () => {
  const t = createTicket({ repo: 'web', title: 'Reopen me', status: 'backlog' });
  actions.plan(t.id);
  updateTicket(t.id, (x) => { x.status = 'needs_info'; x.error = 'questions…'; x.baseSha = 'stale'; });
  assert.equal(actions.reject(t.id).planOnly, false);
  assert.throws(() => actions.run(t.id), /needs: backlog \| failed/);
  const r = actions.reopen(t.id);
  assert.deepEqual([r.status, r.error, r.resume, r.baseSha], ['backlog', '', 'plan', '']);
  assert.throws(() => actions.reopen(t.id), /needs: rejected/);
});

test('claude stream-json becomes a readable live log', async () => {
  const { streamLogger, localModel } = await import('../hub/engines.mjs');
  const f = streamLogger();
  const ev = (o) => f(JSON.stringify(o));
  const out = [
    ev({ type: 'system', subtype: 'init', model: 'qwen3:8b' }),
    ev({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } }),
    ev({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Need the ' } } }),
    ev({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'store file' } } }),
    ev({ type: 'stream_event', event: { type: 'content_block_stop' } }),
    ev({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'dup' }, { type: 'tool_use', name: 'Read', input: { file_path: 'src/app.py' } }] } }),
    ev({ type: 'user', message: { content: [{ type: 'tool_result', content: 'a\nb\nc' }] } }),
    ev({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'boom' }] }] } }),
    ev({ type: 'result', is_error: false, num_turns: 3, duration_ms: 42000, result: 'All done' }),
    f('not json'),
  ].join('').replace(/\d\d:\d\d:\d\d/g, 'T');
  assert.equal(out, 'T ▶ started · model qwen3:8b\nT ⋯ waiting for the model (turn 1)\nT 💭 Need the store file\nT 🔧 Read src/app.py\n'
    + 'T    ↳ ok (3 lines)\nT ⋯ waiting for the model (turn 2)\nT    ✗ boom\nT ⋯ waiting for the model (turn 3)\nT ■ done · 3 turns · 42s\nAll done\nnot json\n');
  assert.equal(localModel('ollama/x').env.CLAUDE_STREAM_IDLE_TIMEOUT_MS, String(30 * 60_000));
});

test('token usage: per turn in the live log, totals for stopped runs, per step on the card', async () => {
  const { streamLogger } = await import('../hub/engines.mjs');
  const f = streamLogger();
  const ev = (o) => f(JSON.stringify({ type: 'stream_event', event: o }));
  ev({ type: 'message_start', message: { usage: { input_tokens: 200, cache_read_input_tokens: 7500, output_tokens: 1 } } });
  ev({ type: 'message_delta', usage: { output_tokens: 1400 } });
  assert.match(ev({ type: 'message_stop' }), /🪙 7\.7k in · 1\.4k out\n$/);
  assert.deepEqual(f.total, { in: 7700, out: 1400 });

  const t = createTicket({ repo: 'web', title: 'Tokens', status: 'backlog' });
  updateTicket(t.id, (x) => { x.tokens = { plan: { in: 9000, out: 1000 }, code: { in: 40000, out: 2000 } }; x.cost.claudeUsd = 0.21; });
  assert.match(card(actions.get(t.id)).text, /Claude ≈ \$0\.21 · 🪙 52k tokens/);
});

test('scheduler: plan-only runs alongside coding; queued tickets say why they wait', async () => {
  const { schedule } = await import('../hub/daemon.mjs');
  const c = { limits: { maxParallel: 1, maxPlanning: 2 }, repos: { web: {}, api: { paused: true } } };
  const T = (id, status, extra = {}) => ({ id, repo: 'web', status, ...extra });
  const ts = [T('T1', 'running'), T('T2', 'ready', { planOnly: true }), T('T3', 'ready', { planOnly: true }), T('T4', 'ready', { planOnly: true }),
    T('T5', 'ready'), { id: 'T6', repo: 'api', status: 'ready' }];
  const { start, wait } = schedule(ts, c, false);
  assert.deepEqual(start.map((t) => t.id), ['T2', 'T3']);
  assert.deepEqual(wait, { T4: 'waiting: 2 plan(s) already running', T5: 'waiting for T1 (one coding ticket per repo)', T6: 'repo paused' });
  // maxPlanning 0: plan-only queues like coding
  assert.deepEqual(schedule(ts, { ...c, limits: { maxParallel: 1, maxPlanning: 0 } }, false).start, []);
  assert.equal(schedule(ts, c, true).wait.T2, 'loop paused');
});

test('auto-run: an idle opted-in repo queues its oldest backlog ticket; anything in flight holds the line', async () => {
  const { autoRun } = await import('../hub/daemon.mjs');
  const c = { repos: { web: { autoRun: true }, api: { autoRun: true }, ops: {}, off: { autoRun: true, paused: true } } };
  const T = (id, repo, status) => ({ id, repo, status });
  const ts = [T('T1', 'web', 'done'), T('T2', 'web', 'rejected'), T('T3', 'web', 'backlog'), T('T4', 'web', 'backlog'),
    T('T5', 'api', 'pr_open'), T('T6', 'api', 'backlog'), T('T7', 'ops', 'backlog'), T('T8', 'off', 'backlog')];
  const { start, wait } = autoRun(ts, c);
  assert.deepEqual(start.map((t) => t.id), ['T3']); // ops not opted in, off paused
  assert.deepEqual(wait, { T6: 'auto-run: next after T5 (pr open)' });
  for (const s of ['ready', 'running', 'needs_info', 'review', 'approved', 'failed']) {
    assert.deepEqual(autoRun([T('T1', 'web', s), T('T2', 'web', 'backlog')], c).start, [], s);
  }
  assert.deepEqual(autoRun([T('T1', 'web', 'done')], c), { start: [], wait: {} }); // empty backlog
});

test('escalation: local coder first, escalation engine after N failed attempts', async () => {
  const { codeEngine, failCount } = await import('../hub/pipeline.mjs');
  const c = { engines: { code: { tool: 'claude', model: 'ollama/qwen3:8b' }, escalate: { tool: 'claude', model: 'sonnet', after: 1 } } };
  assert.equal(codeEngine(c, 0).model, 'ollama/qwen3:8b');
  assert.equal(codeEngine(c, 1).model, 'sonnet');
  assert.equal(codeEngine({ engines: { ...c.engines, escalate: { ...c.engines.escalate, after: 0 } } }, 5).model, 'ollama/qwen3:8b'); // off
  assert.equal(failCount({ history: [{ text: 'verify failed (iteration 3)' }, { text: 'started' }, { text: 'failed: code step failed (claude):' }] }), 2);
  assert.equal(failCount({ failedAttempts: 4, history: [] }), 4);
});

test('local model down: reachable() is false fast for a refused port, true for any HTTP answer', async () => {
  const { reachable } = await import('../hub/engines.mjs');
  const { createServer } = await import('node:http');
  const srv = createServer((_, res) => res.end('Ollama is running')).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  assert.equal(await reachable(url), true);
  srv.close(); await new Promise((r) => srv.once('close', r));
  const t0 = Date.now();
  assert.equal(await reachable(url), false);
  assert.ok(Date.now() - t0 < 3000);
});

test('refresh: a planned-but-unstarted branch fast-forwards to the new base; a branch with work is left alone', async () => {
  const g = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };
  const root = mkdtempSync(join(tmpdir(), 'refresh-'));
  const origin = join(root, 'origin.git'), repo = join(root, 'repo'), other = join(root, 'other');
  g(root, 'init', '--bare', '-b', 'main', origin);
  g(root, 'clone', '-q', origin, repo);
  for (const d of [repo]) { g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 't'); }
  writeFileSync(join(repo, 'a.txt'), 'a\n'); g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'A'); g(repo, 'push', '-q', 'origin', 'main');
  const A = g(repo, 'rev-parse', 'HEAD');
  const c2 = loadConfig(); c2.repos.r = { path: repo.split('\\').join('/'), base: 'main' }; saveConfig(c2);
  const { ensureWorktree, refreshBase } = await import('../hub/pipeline.mjs');
  const t = createTicket({ repo: 'r', title: 'Builds on A', status: 'backlog' });
  const t1 = actions.get(t.id);
  await ensureWorktree(t1, c2.repos.r);
  assert.equal(actions.get(t.id).baseSha, A);
  writeText(t.id, 'brief.md', '# plan written on A\n');

  // Someone merges B on origin (like T1's PR landing).
  g(root, 'clone', '-q', origin, other); g(other, 'config', 'user.email', 't@t'); g(other, 'config', 'user.name', 't');
  writeFileSync(join(other, 'b.txt'), 'b\n'); g(other, 'add', '.'); g(other, 'commit', '-qm', 'B'); g(other, 'push', '-q', 'origin', 'main');
  const B = g(other, 'rev-parse', 'HEAD');
  await refreshBase(actions.get(t.id), c2.repos.r);
  const r = actions.get(t.id);
  assert.deepEqual([r.baseSha, r.planBase, r.setupDone], [B, A, false]);
  assert.ok(existsSync(join(r.worktree, 'b.txt')));

  // Uncommitted work in the worktree: never touched.
  writeFileSync(join(r.worktree, 'wip.txt'), 'wip\n');
  writeFileSync(join(other, 'c.txt'), 'c\n'); g(other, 'add', '.'); g(other, 'commit', '-qm', 'C'); g(other, 'push', '-q', 'origin', 'main');
  await refreshBase(actions.get(t.id), c2.repos.r);
  assert.equal(actions.get(t.id).baseSha, B);
  assert.match(actions.get(t.id).history.at(-1).text, /already has changes; not refreshing/);
});

test('conflicts: a conflicting auto-merge PR gets the base merged in, resolved, verified and pushed; a bad resolution is aborted', async () => {
  const g = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };
  const { ensureWorktree, resolveConflicts, shouldResolve } = await import('../hub/pipeline.mjs');
  const { watchMerge } = await import('../hub/daemon.mjs');
  const root = mkdtempSync(join(tmpdir(), 'conflict-'));
  const origin = join(root, 'origin.git'), repo = join(root, 'repo'), other = join(root, 'other');
  g(root, 'init', '--bare', '-b', 'main', origin);
  g(root, 'clone', '-q', origin, repo);
  g(root, 'clone', '-q', origin, other);
  for (const d of [repo, other]) { g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 't'); }
  writeFileSync(join(repo, 'a.txt'), 'start\n'); g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'A'); g(repo, 'push', '-q', 'origin', 'main');
  const c2 = loadConfig(); c2.repos.c = { path: repo.split('\\').join('/'), base: 'main', setup: '', verify: ['git --version'], autoMerge: true }; saveConfig(c2);

  // The ticket's PR and main both change the same line.
  const open = async (title, line) => {
    const t = createTicket({ repo: 'c', title, status: 'backlog' });
    await ensureWorktree(actions.get(t.id), c2.repos.c);
    const wt = actions.get(t.id).worktree;
    writeFileSync(join(wt, 'a.txt'), `${line}\n`); g(wt, 'commit', '-qam', title); g(wt, 'push', '-q', '-u', 'origin', actions.get(t.id).branch);
    updateTicket(t.id, (x) => { x.status = 'pr_open'; x.pr = 'https://github.com/o/r/pull/1'; x.autoMerge = 'failed'; });
    return actions.get(t.id);
  };
  const t = await open('Ticket edit', 'ticket');
  const bad = await open('Other edit', 'other');
  g(other, 'pull', '-q'); writeFileSync(join(other, 'a.txt'), 'main\n'); g(other, 'commit', '-qam', 'M'); g(other, 'push', '-q', 'origin', 'main');

  const prompts = [];
  const ok = await resolveConflicts(t.id, null, async (p, o) => { prompts.push(p); writeFileSync(join(o.cwd, 'a.txt'), 'main\nticket\n'); return { ok: true, text: '', tail: '', costUsd: 0.5 }; });
  assert.equal(ok, true);
  assert.match(prompts[0], /conflicts in:\n- a\.txt/);
  g(repo, 'fetch', '-q', 'origin');
  assert.equal(g(repo, 'rev-list', '--parents', '-n', '1', `origin/${t.branch}`).split(' ').length, 3); // a merge commit
  assert.equal(g(repo, 'show', `origin/${t.branch}:a.txt`), 'main\nticket');
  g(repo, 'merge-base', '--is-ancestor', 'origin/main', `origin/${t.branch}`);
  const r = actions.get(t.id);
  assert.match(r.history.at(-1).text, /resolved conflicts in 1 file\(s\): a\.txt; pushed/);
  assert.equal(r.cost.claudeUsd, 0.5);

  // Markers left behind on every attempt: give up, abort the merge, leave the branch as it was.
  let calls = 0;
  const kinds = [];
  assert.equal(await resolveConflicts(bad.id, async (_, k) => kinds.push(k), async () => { calls++; return { ok: true, text: '', tail: '', costUsd: 0 }; }), false);
  assert.equal(calls, loadConfig().limits.fixIterations + 1);
  const b = actions.get(bad.id);
  assert.match(b.error, /^conflict resolution failed: gave up/);
  assert.deepEqual(kinds, ['conflict']);
  assert.equal(spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: b.worktree }).status, 1);
  assert.equal(g(b.worktree, 'status', '--porcelain'), '');

  // When the daemon acts: auto-merge repos, CONFLICTING PRs, once per base/head pair, unless the engine is off.
  const pr = { state: 'OPEN', mergeable: 'CONFLICTING', baseRefOid: 'b1', headRefOid: 'h1' };
  const cfg = loadConfig();
  assert.equal(shouldResolve({}, { autoMerge: true }, cfg, pr), true);
  assert.equal(shouldResolve({ conflictTried: 'b1..h1' }, { autoMerge: true }, cfg, pr), false);
  assert.equal(shouldResolve({ conflictTried: 'b1..h1' }, { autoMerge: true }, cfg, { ...pr, baseRefOid: 'b2' }), true);
  assert.equal(shouldResolve({}, { autoMerge: false }, cfg, pr), false);
  assert.equal(shouldResolve({}, { autoMerge: true }, cfg, { ...pr, mergeable: 'MERGEABLE' }), false);
  assert.equal(shouldResolve({}, { autoMerge: true }, { ...cfg, engines: { ...cfg.engines, resolve: { tool: 'off' } } }, pr), false);
  assert.deepEqual(['pending', 'failed', '', 'merged'].map((m) => watchMerge({ autoMerge: m })), [true, true, false, false]);
  assert.equal(watchMerge({ autoMerge: '', error: 'auto-merge failed:\nPull request is not mergeable' }), true);
});

test('bug tickets: CLI --img, planner prompt contract, screenshots staged into the worktree', async () => {
  const { hub } = await import('../hub/cli.mjs');
  const { prompts } = await import('../hub/prompts.mjs');
  const { stageAttachments } = await import('../hub/attachments.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'bugrepo-'));
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  const shot = join(repo, 'fail.png');
  writeFileSync(shot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  assert.match(await hub(['bug', repo, 'Checkout', 'total', 'is', '$0'], { img: shot, severity: 'critical', desc: 'Actual: $0' }), /[A-Z][A-Z0-9]*-\d+ 🐞 critical ready: Checkout total is \$0 · 1 screenshot/);
  await assert.rejects(hub(['bug', repo, 'x'], { img: join(repo, 'nope.png') }), /no such image/);
  const t = listTickets().at(-1);
  assert.deepEqual([t.kind, t.severity, t.status], ['bug', 'critical', 'ready']);

  const wt = mkdtempSync(join(tmpdir(), 'wt-'));
  const images = stageAttachments({ ...t, worktree: wt });
  assert.deepEqual(images, [`.kit/handoff/${t.id}/img-1.png`]);
  assert.ok(existsSync(join(wt, images[0])));

  const plan = prompts.plan(t, ['npm test'], '', images);
  assert.match(plan, /BUG report \(severity: critical\)/);
  assert.match(plan, new RegExp(`Screenshots from the reporter: \.kit/handoff/${t.id}/img-1\.png`));
  assert.match(plan, /Root cause: <path:line/);
  assert.match(plan, /coder cannot see images/);
  // Feature prompts are unchanged (no bug text), so their cached prefix and behaviour stay the same.
  assert.doesNotMatch(prompts.plan(createTicket({ repo: 'web', title: 'Feature' }), []), /BUG|Root cause|Screenshots/);
  assert.match(prompts.quickBrief(t, [], images), /^# Task: Fix: Checkout[\s\S]*Screenshots: \.kit\/handoff\/[\s\S]*regression test that fails before the fix/);
  assert.throws(() => createTicket({ repo: 'web', title: 'x', kind: 'epic' }), /unknown kind/);
});
