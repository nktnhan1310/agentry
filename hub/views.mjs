// JSON shapes the control panel reads (ticket summary/detail) and the repo fields it may edit.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDir, walk } from '../lib/util.mjs';
import { getTicket, normId, readText, ticketFile } from './store.mjs';

const bad = (msg) => { throw new Error(msg); };
export const MEDIA = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', webm: 'video/webm', mp4: 'video/mp4',
  txt: 'text/plain', md: 'text/plain', log: 'text/plain', json: 'text/plain', trx: 'text/plain', xml: 'text/plain' };

export function ticketSummary(t) {
  return { id: t.id, key: t.key || '', url: t.url || '', repo: t.repo, title: t.title, status: t.status, stage: t.stage || '', mode: t.mode, iterations: t.iterations,
    cost: t.cost?.claudeUsd || 0, pr: t.pr, notifiedAt: t.notifiedAt || '', error: (t.error || '').split('\n')[0].slice(0, 160), updatedAt: t.updatedAt, cancel: !!t.cancel };
}

export function ticketDetail(id) {
  const t = getTicket(normId(id));
  const dir = ticketFile(t.id, 'logs');
  const logs = existsSync(dir) ? readdirSync(dir).map((n) => { const s = statSync(join(dir, n)); return { name: n.replace(/\.log$/, ''), size: s.size, mtime: s.mtimeMs }; }).sort((a, b) => a.mtime - b.mtime) : [];
  const files = Object.fromEntries(['brief.md', 'questions.md', 'worker.md', 'review.md', 'summary.md', 'test.md', 'comment.md', 'pr-body.md'].map((f) => [f.replace('.md', '').replace('pr-body', 'prBody'), readText(t.id, f)]));
  const ev = ticketFile(t.id, 'evidence');
  const evidence = isDir(ev) ? walk(ev).map((f) => ({ path: f, size: statSync(join(ev, f)).size, type: MEDIA[f.split('.').pop().toLowerCase()] || '' })) : [];
  return { ...t, files, evidence, diffChars: readText(t.id, 'diff.patch').length, logs };
}

// Repo fields edited as one JSON block in the panel ("Advanced"); the block replaces these keys.
const ADVANCED = { workspace: 'string', wiki: 'list', worktree: 'string', branch: 'string', fetchBase: 'boolean', test: 'boolean',
  agents: ['plan', 'code', 'review', 'test'], commands: ['cleanup', 'evidence', 'publish', 'notify'] };
export function applyAdvanced(r, adv) {
  if (!adv || typeof adv !== 'object' || Array.isArray(adv)) bad('advanced settings must be a JSON object');
  for (const k of Object.keys(adv)) if (!ADVANCED[k]) bad(`unknown field "${k}" (allowed: ${Object.keys(ADVANCED).join(', ')})`);
  for (const [k, type] of Object.entries(ADVANCED)) {
    let v = adv[k];
    if (v === undefined || v === null || v === '') { delete r[k]; continue; }
    if (type === 'list' && typeof v === 'string') v = [v];
    const ok = type === 'list' ? Array.isArray(v) && v.every((x) => typeof x === 'string')
      : Array.isArray(type) ? typeof v === 'object' && !Array.isArray(v) && Object.entries(v).every(([n, x]) => type.includes(n) && typeof x === 'string')
      : typeof v === type;
    if (!ok) bad(`"${k}" must be ${type === 'list' ? 'a list of paths' : Array.isArray(type) ? `an object of strings with keys ${type.join(', ')}` : `a ${type}`}`);
    r[k] = v;
  }
}
