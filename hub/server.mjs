// Local control panel (http://127.0.0.1:<ui.port>): tickets, plans, diffs, logs, repos, kit sources, settings.
// Served by the daemon. No deps; localhost only; mutations need the x-kit-ui header (blocks cross-site requests).
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join, relative, resolve } from 'node:path';
import { doctor } from '../lib/doctor.mjs';
import { lint } from '../lib/lint.mjs';
import { loadConfig as loadKitConfig, report, sync } from '../lib/sync.mjs';
import { isDir, KIT, lineCount, parseFm, read, readJson, sha, walk, write } from '../lib/util.mjs';
import { actions } from './actions.mjs';
import { attachmentPath, createWithImages, fromDataUrl, IMAGE_TYPES, listAttachments, saveAttachments } from './attachments.mjs';
import { hub } from './cli.mjs';
import { e2eConfig, e2eLog, lastRun, runE2e } from './e2e.mjs';
import { notify } from './notify.mjs';
import { repoCommands } from './pipeline.mjs';
import { generate, generateJob, planFiles } from './plans.mjs';
import { run } from './proc.mjs';
import { importCreate, importList, notifyTickets } from './stages.mjs';
import { applyAdvanced, MEDIA, ticketDetail, ticketSummary } from './views.mjs';
import { createTicket, event, getTicket, SEVERITIES, listTickets, loadConfig, loadState, normId, readText, saveConfig, saveState, ticketFile, updateTicket, writeText } from './store.mjs';

const UI = join(KIT, 'hub', 'ui', 'index.html');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg) => { throw new HttpError(400, msg); };
// A file response (evidence) instead of JSON.
class Raw { constructor(buf, type, attach) { this.buf = buf; this.type = type; this.attach = attach; } }
// Resolve a relative path inside root; reject traversal.
function inside(root, rel) {
  const p = resolve(root, rel || '');
  const r = relative(root, p);
  if (!rel || r.startsWith('..') || resolve(r) === r) bad(`path outside ${root}`);
  return p;
}

function publicConfig(cfg) {
  return { ...cfg, telegram: { paired: cfg.telegram.allowedChatIds.length, enabled: !!cfg.telegram.token } };
}

// ---- kit catalog ---------------------------------------------------------------------------------
function kitCatalog() {
  const b = loadKitConfig().budgets;
  const items = [];
  const add = (kind, name, rel, budget) => {
    const text = read(join(KIT, rel));
    const { data, body } = parseFm(text);
    items.push({ kind, name, path: rel, description: data.description || '', model: data.model || '', lines: lineCount(body), budget, targets: data.targets || null });
  };
  for (const f of walk(join(KIT, 'core', 'agents'), { maxDepth: 0 })) add('agents', f.replace(/\.md$/, ''), `core/agents/${f}`, b.agentLines);
  for (const f of walk(join(KIT, 'core', 'commands'), { maxDepth: 0 })) add('commands', f.replace(/\.md$/, ''), `core/commands/${f}`, b.commandLines);
  for (const [root, kind, budget] of [['core/skills', 'skills', b.skillLines], ['packs', 'packs', b.packLines]]) {
    for (const n of readdirSync(join(KIT, root))) if (existsSync(join(KIT, root, n, 'SKILL.md'))) add(kind, n, `${root}/${n}/SKILL.md`, budget);
  }
  for (const f of walk(join(KIT, 'core', 'hooks'), { maxDepth: 0 })) items.push({ kind: 'hooks', name: f, path: `core/hooks/${f}`, description: '', lines: lineCount(read(join(KIT, 'core', 'hooks', f))) });
  const extra = ['kit.config.json', 'core/settings.json', ...walk(join(KIT, 'core', 'templates')).map((f) => `core/templates/${f}`)];
  return { version: loadKitConfig().version, items, files: extra };
}

const KIT_WRITABLE = /^(core\/|packs\/|kit\.config\.json$)/;

// ---- per-repo kit status -------------------------------------------------------------------------
function classify(p) {
  const tool = p.startsWith('.claude/') ? 'claude' : p.startsWith('.opencode/') ? 'opencode' : p.startsWith('.agents/') ? 'codex' : '';
  let m = p.match(/\/(agents|commands)\/(.+)\.md$/);
  if (m) return { kind: m[1], name: m[2], tool };
  m = p.match(/\/skills\/([^/]+)\//);
  if (m) return { kind: 'skills', name: m[1], tool };
  m = p.match(/\/hooks\/([^/]+)$/);
  if (m) return { kind: 'hooks', name: m[1], tool };
  return { kind: 'other', name: p, tool };
}

function repoInfo(name) {
  const cfg = loadConfig();
  const r = cfg.repos[name];
  if (!r) throw new HttpError(404, `no repo ${name}`);
  const path = r.path;
  const m = readJson(join(path, '.kit', 'manifest.json'));
  const groups = new Map();
  for (const [p, h] of Object.entries(m?.files || {})) {
    const c = classify(p);
    const status = !existsSync(join(path, p)) ? 'missing' : sha(read(join(path, p))) !== h ? 'modified' : 'ok';
    const key = `${c.kind}:${c.name}`;
    if (!groups.has(key)) groups.set(key, { kind: c.kind, name: c.name, files: [] });
    groups.get(key).files.push({ path: p, tool: c.tool, status });
  }
  const local = isDir(join(path, '.kit', 'local')) ? walk(join(path, '.kit', 'local')).map((f) => `.kit/local/${f}`) : [];
  const rank = { ok: 0, modified: 1, missing: 2 };
  const installed = [...groups.values()].map((g) => {
    const status = g.files.reduce((s, f) => (rank[f.status] > rank[s] ? f.status : s), 'ok');
    const kitName = m?.names?.[g.name] || g.name; // installed name may carry a namespace
    const isPack = g.kind === 'skills' && (m?.packs || []).includes(kitName);
    const override = local.some((f) => f.startsWith(`.kit/local/${isPack ? 'packs' : g.kind}/${kitName}`));
    return { ...g, name: kitName, installedAs: g.name, kind: isPack ? 'packs' : g.kind, status, tools: [...new Set(g.files.map((f) => f.tool))], override };
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  const wikiFiles = isDir(join(path, '.wiki')) ? walk(join(path, '.wiki')).filter((f) => f.endsWith('.md')).map((f) => `.wiki/${f}`) : [];
  const roots = ['AGENTS.md', 'CLAUDE.md', '.kit/config.json'].filter((f) => existsSync(join(path, f)));
  let cmds = { setup: '', verify: [] };
  try { cmds = repoCommands(r); } catch { /* repo moved */ }
  let e2e = null;
  try { e2e = { ...e2eConfig(r), last: lastRun(name) }; } catch { /* repo moved */ }
  return { name, ...r, exists: existsSync(path), resolved: cmds, e2e, kit: m ? { version: m.kit, latest: loadKitConfig().version, syncedAt: m.syncedAt, tools: m.tools, packs: m.packs } : null,
    installed, local, wikiFiles, roots, tickets: listTickets({ repo: name }).length };
}

// ---- pull requests (GitHub via gh) ---------------------------------------------------------------
// Every PR in each repo, not only hub-made ones; linked to a ticket when its branch matches. Cached briefly.
const PR_FIELDS = 'number,title,state,url,headRefName,baseRefName,isDraft,createdAt,updatedAt,author,reviewDecision,additions,deletions';
const prCache = new Map(); // repo -> { at, data }

async function repoPrs(name, r, fresh) {
  const hit = prCache.get(name);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.data;
  let data;
  if (!existsSync(r.path)) data = { repo: name, prs: [], error: 'repo path missing' };
  else {
    const res = await run('gh', ['pr', 'list', '--state', 'all', '--limit', '40', '--json', PR_FIELDS], { cwd: r.path, timeoutMin: 0.5 });
    if (res.code) data = { repo: name, prs: [], error: res.tail.split('\n').filter(Boolean).slice(-2).join(' ') || `gh exited ${res.code}` };
    else {
      let prs = [];
      try { prs = JSON.parse(res.out || '[]'); } catch { /* keep empty */ }
      data = { repo: name, prs };
    }
  }
  prCache.set(name, { at: Date.now(), data });
  return data;
}

async function listPrs(only, fresh) {
  const cfg = loadConfig();
  const byBranch = new Map(listTickets().map((t) => [`${t.repo}\0${t.branch}`, t]));
  const names = Object.keys(cfg.repos).filter((n) => !only || n === only);
  const results = await Promise.all(names.map((n) => repoPrs(n, cfg.repos[n], fresh)));
  const prs = results.flatMap((x) => x.prs.map((p) => {
    const t = byBranch.get(`${x.repo}\0${p.headRefName}`);
    return { ...p, repo: x.repo, author: p.author?.login || '', ticket: t ? { id: t.id, status: t.status } : null };
  })).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return { prs, errors: results.filter((x) => x.error).map(({ repo, error }) => ({ repo, error })) };
}

const REPO_WRITABLE =/^(\.kit\/local\/|\.wiki\/|\.kit\/config\.json$|AGENTS\.md$|CLAUDE\.md$)/;

function override(name, kind, item) {
  const repo = loadConfig().repos[name];
  if (!repo) throw new HttpError(404, `no repo ${name}`);
  const src ={ agents: `core/agents/${item}.md`, commands: `core/commands/${item}.md`, hooks: `core/hooks/${item}`, skills: `core/skills/${item}`, packs: `packs/${item}` }[kind];
  if (!src || !existsSync(join(KIT, src))) bad(`no kit source for ${kind}/${item}`);
  const destRel = `.kit/local/${kind}/${basename(src)}`;
  const dest = inside(repo.path, destRel);
  if (!existsSync(dest)) cpSync(join(KIT, src), dest, { recursive: true });
  return { path: isDir(dest) ? `${destRel}/SKILL.md` : destRel };
}

// ---- routing -------------------------------------------------------------------------------------
// Ticket creation carries screenshots (base64, already downscaled in the browser), so it gets a bigger cap.
async function body(req, max = 2e6) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > max) bad('body too large'); }
  return s ? JSON.parse(s) : {};
}

async function route(req, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // drop "api"
  const [a, b, c, d] = parts;
  const m = req.method;
  const q = url.searchParams;
  const B = m === 'GET' ? {} : await body(req, a === 'tickets' && (!b || c === 'attachments') ? 40e6 : undefined);

  if (a === 'state' && m === 'GET') {
    const cfg = loadConfig();
    const { autoRun, daemonPid, schedule } = await import('./daemon.mjs');
    const paused = !!loadState().paused;
    const all = listTickets();
    const wait = { ...(paused ? {} : autoRun(all, cfg).wait), ...schedule(all, cfg, paused).wait };
    return { daemon: { pid: daemonPid() || process.pid, paused }, config: publicConfig(cfg), kitVersion: loadKitConfig().version,
      repos: Object.entries(cfg.repos).map(([n, r]) => ({ name: n, path: r.path, base: r.base, paused: !!r.paused, autoRun: !!r.autoRun, autoApprove: !!r.autoApprove, autoMerge: !!r.autoMerge,
        flags: { test: !!r.test, evidence: !!r.commands?.evidence, publish: !!r.commands?.publish, notify: !!r.commands?.notify } })),
      tickets: all.map((t) => ({ ...ticketSummary(t), waiting: wait[t.id] || '' })) };
  }
  if (a === 'prs' && m === 'GET') return listPrs(q.get('repo') || '', q.get('fresh') === '1');
  if (a === 'loop' && m === 'POST') { const s = loadState(); s.paused = !!B.paused; saveState(s); return { paused: s.paused }; }
  if (a === 'import' && m === 'POST') return B.keys ? importCreate([].concat(B.keys), { backlog: !!B.backlog }) : { items: await importList() };
  if (a === 'notify' && m === 'POST') {
    if (!Array.isArray(B.ids) || !B.ids.length) bad('ids required');
    return notifyTickets(B.ids);
  }

  if (a === 'tickets') {
    if (!b && m === 'POST') {
      if (!B.title?.trim()) bad('title required');
      const images = (B.images || []).map(fromDataUrl);
      return ticketSummary(createWithImages({ repo: B.repo, title: B.title.trim(), description: (B.description || '').trim(), status: B.backlog ? 'backlog' : 'ready', mode: B.quick ? 'quick' : 'full',
        key: (B.key || '').trim(), url: (B.url || '').trim(), kind: B.kind || 'feature', severity: B.severity || '' }, images));
    }
    // Many at once (plan import / generated tickets). then: backlog | plan (write briefs, park in backlog) | run.
    if (b === 'bulk' && m === 'POST') {
      const items = (B.items || []).filter((i) => i.title?.trim());
      if (!items.length) bad('pick at least one ticket');
      return items.map((i) => {
        const t = createTicket({ repo: B.repo, title: i.title.trim(), description: (i.description || '').trim(), source: i.source || '', status: B.then === 'run' ? 'ready' : 'backlog' });
        return ticketSummary(B.then === 'plan' ? actions.plan(t.id) : t);
      });
    }
    if (b && !c && m === 'GET') return ticketDetail(b);
    if (b && c === 'diff') return { text: readText(normId(b), 'diff.patch') };
    if (b && c === 'evidence' && m === 'GET') {
      const rel = q.get('path');
      const p = inside(ticketFile(normId(b), 'evidence'), rel);
      if (!existsSync(p) || isDir(p)) throw new HttpError(404, 'no such evidence file');
      const type = MEDIA[rel.split('.').pop().toLowerCase()];
      return new Raw(readFileSync(p), type || 'application/octet-stream', !type);
    }
    if (b && c === 'logs' && d) {
      const p = inside(ticketFile(normId(b), 'logs'), `${d}.log`);
      const lines = existsSync(p) ? stripAnsi(readFileSync(p, 'utf8')).split(/\r?\n/) : [];
      return { text: lines.slice(-(Number(q.get('tail')) || 400)).join('\n'), total: lines.length, mtime: existsSync(p) ? statSync(p).mtimeMs : 0 };
    }
    if (b && c === 'attachments' && m === 'POST') {
      const t = getTicket(normId(b));
      if (t.status === 'running') bad('ticket is running; stop it first');
      const names = saveAttachments(t.id, (B.images || []).map(fromDataUrl));
      updateTicket(t.id, (x) => event(x, `${names.length} screenshot(s) attached${readText(x.id, 'brief.md') ? ' (Re-plan to use them)' : ''}`));
      return ticketDetail(t.id);
    }
    if (b && c === 'brief' && m === 'PUT') {
      const t = getTicket(normId(b));
      if (t.status === 'running') bad('ticket is running; stop it first');
      writeText(t.id, 'brief.md', `${String(B.text || '').trimEnd()}\n`);
      updateTicket(t.id, (x) => { x.resume = 'code'; x.briefEdited = true; x.history.push({ at: new Date().toISOString(), text: 'plan edited in UI' }); });
      return ticketDetail(t.id);
    }
    if (b && c === 'action' && d && m === 'POST') {
      if (d === 'replan') {
        updateTicket(normId(b), (x) => {
          if (!['backlog', 'failed', 'review', 'needs_info'].includes(x.status)) bad(`${x.id} is "${x.status}"; replan needs backlog | failed | review | needs_info`);
          x.resume = 'plan'; x.mode = 'full'; x.status = 'ready'; x.error = ''; x.history.push({ at: new Date().toISOString(), text: 'replan requested' });
        });
        return ticketDetail(b);
      }
      if (!actions[d] || d === 'get') bad(`unknown action ${d}`);
      actions[d](b, B.text);
      return ticketDetail(b);
    }
  }

  if (a === 'repos') {
    if (!b && m === 'POST') return { text: await hub(['repo', 'add', B.path], { name: B.name || undefined, base: B.base || undefined }) };
    if (b && !c && m === 'GET') return repoInfo(b);
    if (b && !c && m === 'PUT') {
      const cfg = loadConfig();
      const r = cfg.repos[b] || bad(`no repo ${b}`);
      if (B.base !== undefined) r.base = B.base;
      if (B.setup !== undefined) { if (B.setup === null) delete r.setup; else r.setup = B.setup; }
      if (B.verify !== undefined) { if (B.verify === null) delete r.verify; else r.verify = B.verify; }
      if (B.advanced !== undefined) applyAdvanced(r, B.advanced);
      for (const k of ['paused', 'autoRun', 'autoApprove', 'autoMerge']) if (B[k] !== undefined) r[k] = !!B[k];
      if (B.mergeMethod !== undefined) r.mergeMethod = ['squash', 'merge', 'rebase'].includes(B.mergeMethod) ? B.mergeMethod : 'squash';
      if (B.e2e) {
        const x = B.e2e;
        r.e2e = { ...(x.cmd?.trim() ? { cmd: x.cmd.trim(), dir: (x.dir || '.').trim().replace(/\\/g, '/') } : {}), enabled: x.enabled !== false, everyHours: Math.max(0, Number(x.everyHours) || 0),
          inVerify: !!x.inVerify, fileBugs: x.fileBugs !== false, autoFix: !!x.autoFix, severity: SEVERITIES.includes(x.severity) ? x.severity : 'high', maxBugs: Math.max(1, Number(x.maxBugs) || 5) };
      }
      saveConfig(cfg);
      return repoInfo(b);
    }
    if (b && !c && m === 'DELETE') { const cfg = loadConfig(); delete cfg.repos[b]; saveConfig(cfg); return { ok: true }; }
    const repo = b && (loadConfig().repos[b] || bad(`no repo ${b}`));
    if (c === 'sync' && m === 'POST') return { text: report(sync(repo.path, { dry: !!B.dry, force: !!B.force }), !!B.dry), info: repoInfo(b) };
    if (c === 'doctor') return { text: doctor(repo.path) };
    if (c === 'e2e' && m === 'POST') {
      if (!e2eConfig(repo).enabled) bad('no e2e tests: add a playwright.config.* or set the command');
      if (lastRun(b)?.status === 'running') bad('an e2e run is already going');
      runE2e(b, notify).catch(() => { /* recorded in last.json */ }); // writes status "running" before its first await
      return { last: lastRun(b) };
    }
    if (c === 'e2e' && m === 'GET') {
      const p = e2eLog(b);
      return { last: lastRun(b), log: existsSync(p) ? stripAnsi(readFileSync(p, 'utf8')).split(/\r?\n/).slice(-300).join('\n') : '' };
    }
    if (c === 'plans' && m === 'GET') return { files: planFiles(b) };
    if (c === 'generate') return m === 'POST' ? generate(b, B.goal) : { job: generateJob(b) };
    if (c === 'override' && m === 'POST') return override(b, B.kind, B.name);
    if (c === 'file') {
      const rel = q.get('path') || B.path;
      const p = inside(repo.path, rel);
      if (m === 'GET') return { path: rel, text: existsSync(p) ? read(p) : '', writable: REPO_WRITABLE.test(rel), exists: existsSync(p) };
      if (m === 'PUT') { if (!REPO_WRITABLE.test(rel)) bad(`${rel} is managed by kit sync; override it instead`); write(p, B.text); return { ok: true }; }
    }
  }

  if (a === 'kit') {
    if (b === 'catalog') return kitCatalog();
    if (b === 'lint') return { text: lint() };
    if (b === 'file') {
      const rel = q.get('path') || B.path;
      const p = inside(KIT, rel);
      if (m === 'GET') return { path: rel, text: existsSync(p) ? read(p) : '', writable: KIT_WRITABLE.test(rel) };
      if (m === 'PUT') { if (!KIT_WRITABLE.test(rel)) bad(`${rel} is not a kit source`); write(p, B.text); return { ok: true, lint: lint() }; }
    }
  }

  if (a === 'config') {
    const cfg = loadConfig();
    if (m === 'GET') return publicConfig(cfg);
    if (m === 'PUT') {
      for (const k of ['engines', 'limits', 'review', 'pr', 'ntfy', 'ui', 'import']) if (B[k]) cfg[k] = { ...cfg[k], ...B[k] };
      if (typeof B.worktreeDir === 'string') cfg.worktreeDir = B.worktreeDir.trim().replace(/\\/g, '/'); // new worktrees only
      saveConfig(cfg);
      return publicConfig(cfg);
    }
  }
  throw new HttpError(404, 'not found');
}

export function startUi(log = console.log) {
  const { host, port } = loadConfig().ui;
  const okHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const server = createServer(async (req, res) => {
    const send = (code, data, type = 'application/json') => {
      res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(type === 'application/json' ? JSON.stringify(data) : data);
    };
    try {
      if (!okHosts.has(req.headers.host)) return send(403, { error: 'bad host' }); // DNS-rebinding guard
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/' || url.pathname === '/index.html') return send(200, readFileSync(UI, 'utf8'), 'text/html');
      if (!url.pathname.startsWith('/api/')) return send(404, { error: 'not found' });
      const img = /^\/api\/tickets\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
      if (img && req.method === 'GET') {
        const id = normId(decodeURIComponent(img[1]));
        const name = decodeURIComponent(img[2]);
        if (!listAttachments(id).includes(name)) return send(404, { error: 'no such attachment' }); // also blocks traversal
        res.writeHead(200, { 'content-type': IMAGE_TYPES[name.split('.').pop()], 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
        return res.end(readFileSync(attachmentPath(id, name)));
      }
      if (req.method !== 'GET' && req.headers['x-kit-ui'] !== '1') return send(403, { error: 'missing x-kit-ui header' });
      const out = await route(req, url);
      if (!(out instanceof Raw)) return send(200, out);
      // Evidence files: sandboxed (no script runs even if a file is mislabelled), unknown types download.
      res.writeHead(200, { 'content-type': out.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox',
        ...(out.attach ? { 'content-disposition': 'attachment' } : {}) });
      res.end(out.buf);
    } catch (e) {
      send(e.code && e.code >= 400 && e.code < 600 ? e.code : 400, { error: String(e.message || e) });
    }
  });
  server.on('error', (e) => log(`ui: ${e.message}`));
  server.listen(port, host, () => log(`ui: http://${host}:${port}`));
  return server;
}

export const uiUrl = () => `http://127.0.0.1:${loadConfig().ui.port}`;
