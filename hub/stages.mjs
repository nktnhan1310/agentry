// Control-panel operations that run repo commands outside a pipeline: notify (one run per command
// for a multi-select) and import (a command that lists tickets from an external tracker).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runCommand, vars } from './commands.mjs';
import { shell } from './engines.mjs';
import { createTicket, event, getTicket, HUB, KEY_RE, listTickets, loadConfig, normId, ticketFile, ticketKey, updateTicket } from './store.mjs';

const tailN = (s, n) => s.split('\n').slice(-n).join('\n');
const IMPORT_FILE = join(HUB, 'import.json');
const STAGES = ['plan', 'code', 'review', 'test'];
const AGENT_RE = /^[\w.:-]*$/;

// Tickets sharing a notify command go out in one run with {tickets} = their keys (one message per click).
export async function notifyTickets(ids) {
  const cfg = loadConfig();
  const groups = new Map();
  for (const id of [...new Set(ids.map(normId))]) {
    const t = getTicket(id);
    const repo = cfg.repos[t.repo];
    const tpl = repo?.commands?.notify;
    if (!tpl) throw new Error(`${t.id}: repo ${t.repo} has no notify command`);
    if (!t.pr) throw new Error(`${t.id} has no PR yet`);
    vars(t, repo);
    if (!groups.has(tpl)) groups.set(tpl, []);
    groups.get(tpl).push({ t, repo });
  }
  const out = [];
  let ok = true;
  for (const [tpl, list] of groups) {
    const { t, repo } = list[0];
    const keys = list.map((x) => ticketKey(x.t)).join(' ');
    const v = { ...vars(t, repo), tickets: keys, prs: list.map((x) => x.t.pr).join(' ') };
    const r = await runCommand(tpl, v, { cwd: t.worktree && existsSync(t.worktree) ? dirname(t.worktree) : undefined, log: ticketFile(t.id, 'logs/notify.log'), timeoutMin: 5 });
    ok &&= r.code === 0;
    for (const x of list) {
      updateTicket(x.t.id, (y) => {
        if (r.code === 0) y.notifiedAt = new Date().toISOString();
        event(y, r.code === 0 ? `notified (${keys})` : `notify failed (exit ${r.code})`);
      });
    }
    out.push(`${r.code === 0 ? '✓' : '✗'} ${keys}\n${tailN(r.tail, 8)}`);
  }
  return { ok, text: out.join('\n\n') };
}

function normalize(i, cfg, open) {
  const s = (x) => (x === undefined || x === null ? '' : String(x));
  const agents = Object.fromEntries(STAGES.filter((k) => typeof i.agents?.[k] === 'string' && AGENT_RE.test(i.agents[k])).map((k) => [k, i.agents[k]]));
  const e = { key: s(i.key), title: s(i.title) || s(i.key), description: s(i.description), repo: s(i.repo), url: s(i.url), agents, mode: i.mode === 'quick' ? 'quick' : 'full', manual: s(i.manual) };
  if (!KEY_RE.test(e.key)) e.manual ||= 'invalid key';
  else if (!cfg.repos[e.repo]) e.manual ||= `repo "${e.repo}" is not registered`;
  e.existing = open.find((x) => x.key === e.key && x.repo === e.repo)?.id || '';
  return e;
}

// Runs import.command; it prints a JSON array (or {tickets: [...]}) of
// {key, title, description, repo, url, agents: {plan, code, review, test}, mode, manual}.
export async function importList() {
  const cfg = loadConfig();
  if (!cfg.import.command) throw new Error('no import command configured (hub config import.command)');
  const r = await shell(cfg.import.command, { timeoutMin: 5 });
  if (r.code) throw new Error(`import command failed:\n${tailN(r.tail, 15)}`);
  let items;
  try { items = JSON.parse(r.out.slice(r.out.search(/[[{]/))); } catch { throw new Error(`import command did not print JSON:\n${tailN(r.tail, 10)}`); }
  if (!Array.isArray(items)) items = items.tickets;
  if (!Array.isArray(items)) throw new Error('import JSON must be an array or {tickets: [...]}');
  const open = listTickets().filter((x) => !['rejected', 'done'].includes(x.status));
  const list = items.map((i) => normalize(i, cfg, open));
  writeFileSync(IMPORT_FILE, JSON.stringify(list, null, 2));
  return list;
}

// Creates tickets for the picked keys from the last importList() result (never re-runs the command).
export function importCreate(keys, { backlog = false } = {}) {
  const list = existsSync(IMPORT_FILE) ? JSON.parse(readFileSync(IMPORT_FILE, 'utf8')) : [];
  const created = [];
  const skipped = [];
  for (const k of new Set(keys)) {
    const items = list.filter((x) => x.key === k);
    if (!items.length) skipped.push(`${k}: not in the last import`);
    for (const e of items) {
      if (e.manual) { skipped.push(`${k}: ${e.manual}`); continue; }
      try {
        const t = createTicket({ repo: e.repo, title: e.title, description: e.description, key: e.key, url: e.url, agents: e.agents, mode: e.mode, status: backlog ? 'backlog' : 'ready' });
        created.push(t.id);
      } catch (err) { skipped.push(`${k}: ${err.message}`); }
    }
  }
  return { created, skipped };
}
