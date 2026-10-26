import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.KIT_HUB_DIR = mkdtempSync(join(tmpdir(), 'hub-ui-'));
const { loadConfig, saveConfig, writeText } = await import('../hub/store.mjs');
const port = 20000 + Math.floor(Math.random() * 20000);
const cfg = loadConfig();
cfg.ui.port = port;
cfg.repos = { web: { path: mkdtempSync(join(tmpdir(), 'web-')), base: 'main' } };
saveConfig(cfg);
const { startUi } = await import('../hub/server.mjs');

test('control panel API: state, guards, tickets, kit catalog', async (t) => {
  const server = startUi(() => {});
  t.after(() => server.close());
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const B = `http://127.0.0.1:${port}`;
  const post = (p, body, h = { 'x-kit-ui': '1' }) => fetch(`${B}/api/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });

  const html = await (await fetch(B)).text();
  assert.match(html, /agentry hub/);
  assert.match(html, /<header>[\s\S]*<nav id="nav">[\s\S]*<\/nav>[\s\S]*<button id="themeBtn"[\s\S]*<\/header>/, 'theme switch sits in the top bar, after the nav');
  assert.match(html, /:root\[data-theme="dark"\]/);
  assert.match(html, /<button id="importBtn" style="display:none"/, 'Import is opt-in: hidden until import.command is set');
  assert.match(html, /:root:not\(\[data-theme="light"\]\)/);
  const s = await (await fetch(`${B}/api/state`)).json();
  assert.equal(s.repos[0].name, 'web');
  assert.equal(s.config.telegram.token, undefined); // secrets never leave the server

  assert.equal((await post('tickets', { repo: 'web', title: 'x' }, {})).status, 403); // no x-kit-ui header
  const created = await (await post('tickets', { repo: 'web', title: 'Add login', backlog: true })).json();
  assert.equal(created.status, 'backlog');
  const run = await (await post(`tickets/${created.id}/action/run`, {})).json();
  assert.equal(run.status, 'ready');
  assert.match((await (await post(`tickets/${created.id}/action/approve`, {})).json()).error, /needs: review/);

  // Evidence: served with its media type, sandboxed; traversal refused; unknown types download.
  writeText(created.id, 'evidence/shot.png', 'PNG');
  writeText(created.id, 'evidence/run.bin', 'x');
  const detail = await (await fetch(`${B}/api/tickets/${created.id}`)).json();
  assert.deepEqual(detail.evidence.map((f) => [f.path, f.type]), [['run.bin', ''], ['shot.png', 'image/png']]);
  const evImg = await fetch(`${B}/api/tickets/${created.id}/evidence?path=shot.png`);
  assert.equal(evImg.headers.get('content-type'), 'image/png');
  assert.equal(evImg.headers.get('content-security-policy'), 'sandbox');
  assert.equal((await fetch(`${B}/api/tickets/${created.id}/evidence?path=run.bin`)).headers.get('content-disposition'), 'attachment');
  assert.equal((await fetch(`${B}/api/tickets/${created.id}/evidence?path=../ticket.json`)).status, 400);

  // Advanced repo fields: validated, replace the block, surface as flags.
  const putAdv = (advanced) => fetch(`${B}/api/repos/web`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-kit-ui': '1' }, body: JSON.stringify({ advanced }) });
  assert.match((await (await putAdv({ sneaky: 1 })).json()).error, /unknown field "sneaky"/);
  assert.match((await (await putAdv({ commands: { deploy: 'x' } })).json()).error, /commands" must be an object of strings with keys cleanup, evidence, publish, notify/);
  const repo = await (await putAdv({ workspace: 'D:/ws', wiki: 'D:/ws/notes.md', test: true, commands: { publish: 'pub {ticket}', notify: 'n {tickets}' } })).json();
  assert.deepEqual([repo.workspace, repo.wiki, repo.test], ['D:/ws', ['D:/ws/notes.md'], true]);
  assert.deepEqual(repo.commands, { publish: 'pub {ticket}', notify: 'n {tickets}' }, 'configured commands are not shadowed by the resolved setup/verify');
  assert.ok(Array.isArray(repo.resolved.verify) && 'setup' in repo.resolved);
  assert.deepEqual((await (await fetch(`${B}/api/state`)).json()).repos[0].flags, { test: true, evidence: false, publish: true, notify: true });
  assert.equal((await (await putAdv({ test: true })).json()).workspace, undefined, 'omitted keys are removed');
  assert.match((await (await post('notify', { ids: [] })).json()).error, /ids required/);

  assert.equal((await fetch(`${B}/api/kit/file?path=../package.json`)).status, 400);
  const cat = await (await fetch(`${B}/api/kit/catalog`)).json();
  assert.ok(cat.items.some((i) => i.kind === 'agents' && i.name === 'planner'));

  // Per-repo autopilot settings round-trip; unknown merge methods fall back to squash.
  const put = (p, body) => fetch(`${B}/api/${p}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-kit-ui': '1' }, body: JSON.stringify(body) });
  const r = await (await put('repos/web', { paused: true, autoApprove: true, autoMerge: true, mergeMethod: 'yolo' })).json();
  assert.deepEqual([r.paused, r.autoApprove, r.autoMerge, r.mergeMethod], [true, true, true, 'squash']);
  assert.equal((await (await fetch(`${B}/api/state`)).json()).repos[0].paused, true);

  // PR list: a non-GitHub repo reports an error instead of failing the whole request.
  const prs = await (await fetch(`${B}/api/prs`)).json();
  assert.ok(Array.isArray(prs.prs));
  assert.equal(prs.errors[0]?.repo, 'web');

  // Bulk creation from a plan: backlog, plan-only (writes briefs, parks in backlog), or run.
  const bulk = async (body) => (await post('tickets/bulk', body)).json();
  const items = [{ title: 'One', description: 'Goal: 1', source: '.wiki/plans/mvp.md#1' }, { title: 'Two' }];
  assert.deepEqual((await bulk({ repo: 'web', items, then: 'backlog' })).map((x) => x.status), ['backlog', 'backlog']);
  const planned = await bulk({ repo: 'web', items: [{ title: 'Three' }], then: 'plan' });
  assert.deepEqual([planned[0].status, planned[0].planOnly], ['ready', true]);
  assert.equal((await bulk({ repo: 'web', items: [{ title: 'Four' }], then: 'run' }))[0].status, 'ready');
  assert.match((await bulk({ repo: 'web', items: [] })).error, /at least one/);

  // Bug tickets: screenshots are stored (validated by content, not name) and served back; the ticket only queues afterwards.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const bug = await (await post('tickets', { repo: 'web', title: 'Total shows $0', kind: 'bug', severity: 'high', images: [png] })).json();
  assert.deepEqual([bug.kind, bug.severity, bug.status], ['bug', 'high', 'ready']);
  const d = await (await fetch(`${B}/api/tickets/${bug.id}`)).json();
  assert.deepEqual(d.attachments, ['img-1.png']);
  const img = await fetch(`${B}/api/tickets/${bug.id}/attachments/img-1.png`);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await img.arrayBuffer()).byteLength, 70);
  assert.equal((await fetch(`${B}/api/tickets/${bug.id}/attachments/..%2Fticket.json`)).status, 404);
  const fake = `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`;
  assert.match((await (await post('tickets', { repo: 'web', title: 'x', kind: 'bug', images: [fake] })).json()).error, /only PNG/);
  assert.match((await (await post('tickets', { repo: 'web', title: 'x', kind: 'bug', severity: 'meh' })).json()).error, /severity/);
  const more = await (await post(`tickets/${bug.id}/attachments`, { images: [png, png] })).json();
  assert.deepEqual(more.attachments, ['img-1.png', 'img-2.png', 'img-3.png']);
  assert.match((await (await post(`tickets/${bug.id}/attachments`, { images: Array(4).fill(png) })).json()).error, /at most 6/);
  assert.equal((await (await fetch(`${B}/api/state`)).json()).tickets.find((x) => x.id === bug.id).kind, 'bug');

  // E2E settings: no Playwright config → disabled and Run is refused; settings round-trip and are clamped.
  assert.equal((await (await fetch(`${B}/api/repos/web`)).json()).e2e.enabled, false);
  assert.match((await (await post('repos/web/e2e', {})).json()).error, /no e2e tests/);
  const e = (await (await put('repos/web', { e2e: { cmd: ' npx playwright test ', dir: 'apps\\web', everyHours: -3, severity: 'nope', inVerify: true } })).json()).e2e;
  assert.deepEqual([e.enabled, e.cmd, e.dir, e.everyHours, e.severity, e.inVerify, e.fileBugs, e.maxBugs], [true, 'npx playwright test', 'apps/web', 0, 'high', true, true, 5]);
  assert.equal((await (await fetch(`${B}/api/repos/web/e2e`)).json()).last, null);
});

test('phone access: remote hosts need a paired device; codes are one-use, local-only, limited', async (t) => {
  const c = loadConfig();
  c.ui.port = port + 1;
  c.ui.remoteHosts = ['pc.tail.ts.net'];
  saveConfig(c);
  const server = startUi(() => {});
  t.after(() => server.close());
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  // node:http so the Host and proxy headers can be set the way `tailscale serve` sends them.
  const req = (method, path, { host = 'pc.tail.ts.net', proxied = true, cookie, body } = {}) => new Promise((resolve, reject) => {
    const headers = { host, ...(proxied ? { 'x-forwarded-for': '100.65.180.95', 'x-forwarded-proto': 'https' } : {}), ...(cookie ? { cookie } : {}),
      ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-kit-ui': '1' }) };
    const r = request({ host: '127.0.0.1', port: port + 1, method, path, headers }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: s.startsWith('{') || s.startsWith('[') ? JSON.parse(s) : null, text: s }));
    });
    r.on('error', reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const local = { host: `127.0.0.1:${port + 1}`, proxied: false };

  assert.equal((await req('GET', '/api/state', { host: 'evil.example', proxied: false })).status, 403); // DNS rebinding
  assert.equal((await req('GET', '/')).status, 200); // the shell loads so it can show the pairing card
  const denied = await req('GET', '/api/state');
  assert.deepEqual([denied.status, denied.json.pair], [401, true]);
  assert.equal((await req('GET', '/api/tickets/X-1/attachments/img-1.png')).status, 401);
  assert.equal((await req('GET', '/api/state', { host: `127.0.0.1:${port + 1}` })).status, 401); // localhost Host but proxied

  assert.equal((await req('POST', '/api/devices/pair', {})).status, 401);
  assert.match((await req('POST', '/api/pair', { body: { code: 'AAAA-AAAA' } })).json.error, /no pairing code/);

  // Five wrong tries burn the code.
  let code = (await req('POST', '/api/devices/pair', local)).json.code;
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  for (let i = 0; i < 4; i++) assert.equal((await req('POST', '/api/pair', { body: { code: 'ZZZZ-ZZZZ' } })).json.error, 'wrong code');
  assert.match((await req('POST', '/api/pair', { body: { code: 'ZZZZ-ZZZZ' } })).json.error, /too many/);
  assert.match((await req('POST', '/api/pair', { body: { code } })).json.error, /no pairing code/);

  code = (await req('POST', '/api/devices/pair', local)).json.code;
  const paired = await req('POST', '/api/pair', { body: { code: code.toLowerCase().replace('-', ' '), name: 'Android phone' } });
  assert.equal(paired.status, 200);
  const setCookie = paired.headers['set-cookie'][0];
  assert.match(setCookie, /^kit_device=[\w-]{43};.*HttpOnly.*SameSite=Strict.*Secure/);
  const cookie = setCookie.split(';')[0];
  assert.match((await req('POST', '/api/pair', { body: { code } })).json.error, /no pairing code/); // one use

  const s = await req('GET', '/api/state', { cookie });
  assert.equal(s.status, 200);
  assert.deepEqual(s.json.viewer, { remote: true, device: { id: paired.json.device.id, name: 'Android phone' } });
  assert.ok(s.json.config.devices.every((d) => !('hash' in d))); // token hashes never leave the server
  assert.equal((await req('POST', '/api/devices/pair', { cookie, body: {} })).status, 403); // codes only on the PC
  assert.equal((await req('PUT', '/api/config', { cookie, body: { ui: { remoteHosts: ['x.example'] } } })).status, 403);
  assert.equal((await req('PUT', '/api/config', { cookie, body: { pr: { draft: true } } })).status, 200);
  assert.equal((await req('GET', '/api/state', { cookie: 'kit_device=forged' })).status, 401);

  assert.equal((await req('DELETE', `/api/devices/${paired.json.device.id}`, local)).status, 200);
  assert.equal((await req('GET', '/api/state', { cookie })).status, 401); // revoked
  assert.equal((await req('GET', '/api/state', local)).json.viewer.remote, false);
});
