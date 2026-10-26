import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.KIT_HUB_DIR = mkdtempSync(join(tmpdir(), 'hub-e2e-'));
const { listTickets, loadConfig, saveConfig, updateTicket } = await import('../hub/store.mjs');
const { e2eConfig, parseReport, runE2e, triage } = await import('../hub/e2e.mjs');
const { repoCommands } = await import('../hub/pipeline.mjs');
const { actions } = await import('../hub/actions.mjs');
const { listAttachments } = await import('../hub/attachments.mjs');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' });

// A stand-in for `npx playwright test`: writes a Playwright-format JSON report (+ a failure screenshot) and
// exits 1 when a test fails. FAKE_PW_PASS=1 makes every test pass.
const FAKE = `import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const pass = process.env.FAKE_PW_PASS === '1';
mkdirSync('test-results', { recursive: true });
const shot = resolve('test-results/coupon-failed-1.png');
writeFileSync(shot, Buffer.from('${PNG}', 'base64'));
const t = (title, line, status, extra = {}) => ({ title, file: 'checkout.spec.ts', line, tests: [{ projectName: 'chromium', status,
  results: [{ status: status === 'expected' ? 'passed' : 'failed', ...extra }] }] });
const report = { suites: [{ title: 'checkout.spec.ts', file: 'checkout.spec.ts', specs: [], suites: [{ title: 'Checkout', specs: [
  t('shows the total', 5, 'expected'),
  pass ? t('applies a coupon', 12, 'expected') : t('applies a coupon', 12, 'unexpected', { error: { message: '\\u001b[31mExpected: 90\\u001b[39m\\nReceived: 0' }, attachments: [{ name: 'screenshot', contentType: 'image/png', path: shot }] }),
  t('sometimes slow', 20, 'flaky'),
] }] }] };
writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_NAME, JSON.stringify(report));
process.exit(pass ? 0 : 1);
`;

test('e2e run: failing test → bug with screenshot; rerun dedupes; once fixed and passing → verified', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'e2e-repo-'));
  g(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'fake-pw.mjs'), FAKE);
  g(repo, 'add', '.'); g(repo, 'commit', '-qm', 'init');
  const cfg = loadConfig();
  cfg.worktreeDir = mkdtempSync(join(tmpdir(), 'e2e-wt-'));
  cfg.repos.shop = { path: repo, base: 'main', e2e: { cmd: 'node fake-pw.mjs', everyHours: 0 } };
  saveConfig(cfg);

  const r1 = await runE2e('shop');
  assert.equal(r1.error, '');
  assert.deepEqual([r1.status, r1.passed, r1.failed, r1.flaky, r1.filed.length], ['failed', 1, 1, 1, 1]); // flaky is not a bug
  const bug = listTickets({ repo: 'shop' })[0];
  assert.deepEqual([bug.kind, bug.severity, bug.status, bug.title], ['bug', 'high', 'backlog', 'E2E fails: Checkout › applies a coupon']);
  assert.equal(bug.source, 'e2e:checkout.spec.ts::Checkout › applies a coupon [chromium]');
  assert.match(bug.description, /checkout\.spec\.ts:12[\s\S]*Expected: 90\nReceived: 0[\s\S]*Reproduce: node fake-pw\.mjs checkout\.spec\.ts:12 --project=chromium/);
  assert.doesNotMatch(bug.description, /\x1b/); // ANSI stripped: no wasted tokens
  assert.deepEqual(listAttachments(bug.id), ['img-1.png']);

  const r2 = await runE2e('shop');
  assert.deepEqual([r2.filed, r2.still], [[], [bug.id]]);

  updateTicket(bug.id, (x) => { x.status = 'done'; });
  process.env.FAKE_PW_PASS = '1';
  const r3 = await runE2e('shop');
  delete process.env.FAKE_PW_PASS;
  assert.deepEqual([r3.status, r3.verified], ['passed', [bug.id]]);
  assert.equal(actions.get(bug.id).verifiedBy, 'e2e');

  // Broken again later: a regression bug that points at the earlier fix.
  const r4 = await runE2e('shop');
  assert.equal(r4.filed.length, 1);
  assert.match(actions.get(r4.filed[0]).description, new RegExp(`Regression: ${bug.id} fixed this before`));
});

test('e2e: many failures become one grouped bug; config detection; verify-step command', () => {
  const tests = parseReport({ suites: [{ title: 'a.spec.ts', specs: Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, file: 'a.spec.ts', line: i + 1,
    tests: [{ projectName: '', status: 'unexpected', results: [{ error: { message: 'net::ERR_CONNECTION_REFUSED' } }] }] })) }] });
  assert.equal(tests[0].key, 'a.spec.ts::t0');
  const cfg = loadConfig();
  cfg.repos.big = { path: mkdtempSync(join(tmpdir(), 'big-')), base: 'main' };
  saveConfig(cfg);
  const out = triage('big', cfg.repos.big, e2eConfig({ ...cfg.repos.big, e2e: { cmd: 'npx playwright test' } }), tests, { base: 'main', sha: 'abcdef1234' });
  assert.equal(out.filed.length, 1);
  const t = actions.get(out.filed[0]);
  assert.match(t.title, /^E2E: 8 tests failing on main/);
  assert.match(t.description, /ERR_CONNECTION_REFUSED[\s\S]*Also failing:\n- a\.spec\.ts:2 t1/);

  const repo = mkdtempSync(join(tmpdir(), 'pw-'));
  mkdirSync(join(repo, 'web'));
  writeFileSync(join(repo, 'web', 'playwright.config.ts'), 'export default {}\n');
  const e = e2eConfig({ path: repo });
  assert.deepEqual([e.enabled, e.cmd, e.dir, e.detected], [true, 'npx playwright test', 'web', true]);
  assert.ok(!repoCommands({ path: repo, verify: ['npm test'] }).verify.some((c) => /playwright/.test(c)));
  assert.deepEqual(repoCommands({ path: repo, verify: ['npm test'], e2e: { inVerify: true } }).verify, ['npm test', 'cd web && npx playwright test --reporter=line']);
});

test('bug verify / still broken', () => {
  const cfg = loadConfig();
  const bug = listTickets({ repo: 'shop' }).find((t) => t.kind === 'bug');
  assert.ok(cfg.repos.shop && bug);
  assert.throws(() => actions.verify(listTickets({ repo: 'big' })[0].id), /needs: done/);
  updateTicket(bug.id, (x) => { x.verifiedAt = ''; x.pr = 'https://github.com/o/r/pull/7'; });
  assert.throws(() => actions.broken(bug.id, ' '), /still broken/);
  const old = actions.broken(bug.id, 'Coupon still ignored on mobile');
  const n = actions.get(old.reopenedAs);
  assert.deepEqual([n.kind, n.severity, n.status, n.source], ['bug', bug.severity, 'ready', bug.source]);
  assert.match(n.title, /^Still broken: E2E fails/);
  assert.match(n.description, /Still broken after [A-Z][A-Z0-9]*-\d+ \(https:\/\/github\.com\/o\/r\/pull\/7\)\nCoupon still ignored on mobile/);
  assert.deepEqual(listAttachments(n.id), listAttachments(bug.id)); // screenshots carried over
  assert.equal(actions.verify(bug.id).verifiedBy, 'you');
});
