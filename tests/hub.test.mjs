import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.KIT_HUB_DIR = mkdtempSync(join(tmpdir(), 'hub-'));
const { createTicket, listTickets, loadConfig, saveConfig, updateTicket, writeText } = await import('../hub/store.mjs');
const { actions } = await import('../hub/actions.mjs');
const { card, parseNew } = await import('../hub/telegram.mjs');

const cfg = loadConfig();
cfg.repos = { web: { path: '/tmp/web', base: 'main' }, api: { path: '/tmp/api', base: 'main' } };
saveConfig(cfg);

test('ticket state machine guards transitions', () => {
  const t = createTicket({ repo: 'web', title: 'Add login', status: 'backlog' });
  assert.equal(t.id, 'T1');
  assert.throws(() => actions.approve('T1'), /needs: review/);
  assert.equal(actions.run('1').status, 'ready');
  updateTicket('T1', (x) => { x.status = 'review'; });
  assert.equal(actions.changes('T1', 'rename button').status, 'ready');
  const t2 = actions.get('T1');
  assert.equal(t2.resume, 'code');
  assert.deepEqual(t2.feedback, ['rename button']);
  updateTicket('T1', (x) => { x.status = 'needs_info'; });
  writeText('T1', 'questions.md', '1. OAuth or password?');
  const t3 = actions.answer('T1', 'password');
  assert.equal(t3.resume, 'plan');
  assert.match(t3.answers[0], /OAuth or password\?[\s\S]*password/);
  assert.throws(() => createTicket({ repo: 'nope', title: 'x' }), /unknown repo/);
});

test('hub add accepts a repo path, registers it, reads --desc-file', async () => {
  const { hub } = await import('../hub/cli.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'repo-'));
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  mkdirSync(join(repo, '.kit', 'handoff'), { recursive: true });
  const draft = join(repo, '.kit', 'handoff', 'new-ticket.md');
  writeFileSync(draft, 'Goal: x\n');
  const out = await hub(['add', repo, 'Do', 'thing'], { 'desc-file': draft, quick: true });
  assert.match(out, /repo "repo-\w+"[\s\S]*T\d+ ready \(quick\): Do thing/);
  assert.ok(!existsSync(draft));
  const t = listTickets().at(-1);
  assert.equal(t.description, 'Goal: x');
  assert.match(await hub(['add', repo, 'Again'], {}), /^T\d+ ready: Again/); // second time: matched, not re-registered
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
});

test('ollama/ models route claude to local Ollama', async () => {
  const { localModel } = await import('../hub/engines.mjs');
  assert.equal(localModel('opus'), null);
  const l = localModel('ollama/qwen3:8b-32k');
  assert.equal(l.model, 'qwen3:8b-32k');
  assert.equal(l.env.ANTHROPIC_BASE_URL, 'http://localhost:11434');
  assert.equal(l.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'qwen3:8b-32k');
});
