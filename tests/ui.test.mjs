import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.KIT_HUB_DIR = mkdtempSync(join(tmpdir(), 'hub-ui-'));
const { loadConfig, saveConfig } = await import('../hub/store.mjs');
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
  assert.match(html, /<header>[\s\S]*<nav id="nav">[\s\S]*<\/nav>\s*<div id="theme" class="seg"[\s\S]*data-t="auto"[\s\S]*data-t="light"[\s\S]*data-t="dark"[\s\S]*<\/header>/, 'theme switch sits in the top bar, right after the nav');
  assert.match(html, /:root\[data-theme="dark"\]/);
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

  assert.equal((await fetch(`${B}/api/kit/file?path=../package.json`)).status, 400);
  const cat = await (await fetch(`${B}/api/kit/catalog`)).json();
  assert.ok(cat.items.some((i) => i.kind === 'agents' && i.name === 'planner'));
});
