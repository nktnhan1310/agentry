// Turning plans into tickets: parse .wiki/plans/*.md, or ask the plan engine to split a goal into tickets.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { engine } from './engines.mjs';
import { prompts } from './prompts.mjs';
import { HUB, listTickets, loadConfig } from './store.mjs';

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Item headings: "## 2. Kline store", "**1.8 Rate-limit governor** → mvp 1", or one-liners
// "**4.1 State features** → 1.9 · Acceptance: …". A heading only counts when its section has a Goal or
// Acceptance line, so prose sections (vision docs, phase headers) are skipped.
const HEAD = [/^#{2,4}\s+(\d+(?:\.\d+)*)[.)]?\s+(.+?)\s*$/, /^\*\*(\d+(?:\.\d+)*)[.)]?\s+(.+?)\*\*\s*(.*)$/];

export function parsePlan(text, file) {
  const items = [];
  let cur = null;
  const close = () => { if (cur && /^\s*(\*\*)?(goal|acceptance)\b/im.test(cur.body.join('\n'))) items.push(cur); cur = null; };
  for (const line of text.split(/\r?\n/)) {
    const m = HEAD.map((r) => line.match(r)).find(Boolean);
    if (m) {
      close();
      // Tail after the bold title: optional "→ deps", then " · "-separated inline fields.
      const parts = (m[3] || '').replace(/^·\s*/, '').split(/\s*·\s+/).filter(Boolean);
      const deps = parts[0]?.startsWith('→') ? parts.shift().slice(1).trim() : '';
      cur = { key: m[1], title: m[2].replace(/\*\*/g, '').trim(), deps: /^[—-]?$/.test(deps) ? '' : deps, body: parts };
      continue;
    }
    if (/^#{1,4}\s/.test(line)) { close(); continue; }
    cur?.body.push(line);
  }
  close();
  return items.map(({ key, title, deps, body }) => {
    const superseded = /superseded|\bdone\b|✅/i.test(title);
    const clean = title.replace(/\s*[—-]\s*superseded.*$/i, '').trim();
    const description = [body.join('\n').trim(), deps && `Depends on: ${deps}`, `Source: ${file} item ${key}`].filter(Boolean).join('\n\n');
    return { key, title: clean, description, source: `${file}#${key}`, superseded };
  });
}

// Mark items that are already tickets (same source, or same title) so they are not imported twice.
function markExisting(repo, items) {
  const ts = listTickets({ repo }).filter((t) => t.status !== 'rejected'); // a rejected ticket can be imported again
  const bySource = new Map(ts.filter((t) => t.source).map((t) => [t.source, t]));
  const byTitle = new Map(ts.map((t) => [norm(t.title), t]));
  return items.map((i) => {
    const t = (i.source && bySource.get(i.source)) || byTitle.get(norm(i.title));
    return { ...i, ticket: t ? { id: t.id, status: t.status } : null };
  });
}

export function planFiles(repo) {
  const r = loadConfig().repos[repo];
  const dir = join(r.path, '.wiki', 'plans');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const file = `.wiki/plans/${f}`;
    return { file, items: markExisting(repo, parsePlan(readFileSync(join(dir, f), 'utf8'), file)) };
  }).filter((f) => f.items.length);
}

// ---- generate with the plan engine (background job per repo; the UI polls it) ----------------------
const jobs = new Map(); // repo -> { status, goal, startedAt, items, error, costUsd }

export function parseItems(text) {
  const s = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  const arr = JSON.parse(s);
  if (!Array.isArray(arr)) throw new Error('expected a JSON array');
  return arr.filter((x) => x && x.title).map((x) => ({ title: String(x.title).trim().slice(0, 120), description: String(x.description || '').trim() }));
}

export function generate(repo, goal) {
  const cfg = loadConfig();
  const r = cfg.repos[repo];
  if (jobs.get(repo)?.status === 'running') throw new Error('already generating tickets for this repo');
  if (!goal?.trim()) throw new Error('describe the goal first');
  const job = { status: 'running', goal: goal.trim(), startedAt: new Date().toISOString(), items: [], error: '', costUsd: 0 };
  jobs.set(repo, job);
  const existing = listTickets({ repo }).filter((t) => t.status !== 'rejected').map((t) => `- ${t.id} [${t.status}] ${t.title}`).join('\n');
  const e = cfg.engines.plan;
  // The plan engine reads the repo read-only; "opencode" cannot guarantee that, so this always runs claude.
  engine('claude')(prompts.tickets(job.goal, existing), { cwd: r.path, model: e.tool === 'claude' ? e.model : '', write: false, log: join(HUB, 'plans', `${repo}.log`), timeoutMin: cfg.limits.stageTimeoutMin, budgetUsd: cfg.limits.claudeBudgetUsd })
    .then((res) => {
      job.costUsd = res.costUsd; job.tokens = res.tokens;
      if (!res.ok) throw new Error(res.tail.split('\n').slice(-5).join('\n') || 'claude failed');
      job.items = markExisting(repo, parseItems(res.text).map((i) => ({ ...i, source: '' })));
      job.status = 'done';
    })
    .catch((err) => { job.status = 'failed'; job.error = String(err.message || err).slice(0, 1500); });
  return job;
}

export const generateJob = (repo) => jobs.get(repo) || null;
