// Local-only ticket store: ~/.kit-hub (override with KIT_HUB_DIR). Never inside a repo.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deepMerge } from '../lib/util.mjs';

export const HUB = process.env.KIT_HUB_DIR || join(homedir(), '.kit-hub');
export const paths = {
  config: join(HUB, 'hub.json'),
  state: join(HUB, 'state.json'),
  pid: join(HUB, 'daemon.pid'),
  log: join(HUB, 'daemon.log'),
  tickets: join(HUB, 'tickets'),
  worktrees: join(HUB, 'worktrees'),
};

export const DEFAULT_CONFIG = {
  repos: {},
  // Where ticket worktrees live (empty = ~/.kit-hub/worktrees). Put it on a big/fast drive, e.g. D:/kit-worktrees.
  worktreeDir: '',
  // Opus writes the brief once per ticket (a sharper brief saves fix loops); sonnet reviews; free opencode codes and fixes.
  // `agent` = a Claude Code agent (`claude --agent`) for that stage; repo `agents.<stage>` and ticket `agents.<stage>` override it.
  engines: {
    plan: { tool: 'claude', model: 'opus', agent: '' },
    code: { tool: 'opencode', model: '', agent: '' },
    review: { tool: 'claude', model: 'sonnet', agent: '' },
    test: { tool: 'claude', model: '', agent: '' },
    // Two-audience report (plain language + engineers) for Telegram, the UI and the PR body. tool "off" disables it.
    summary: { tool: 'claude', model: 'haiku' },
    // After `after` failed attempts on a ticket, code with this engine instead (0 = off). E.g. local model first, then sonnet.
    escalate: { tool: 'claude', model: 'sonnet', after: 0 },
    // Auto-merge repos: when a PR conflicts with its base, merge the base in and resolve with this engine. "off" disables.
    resolve: { tool: 'claude', model: 'opus' },
  },
  // Per repo (in repos.<name>): paused, autoRun (queue the oldest backlog ticket when the repo is idle), autoApprove (push + PR once verify and review pass), autoMerge, mergeMethod.
  limits: { maxParallel: 1, maxPlanning: 2, fixIterations: 3, reviewRounds: 1, stageTimeoutMin: 30, claudeBudgetUsd: 1 },
  // Skip the Claude review for tiny diffs; inline the diff so review is usually one turn (no file-read round trips).
  review: { skipUnderLines: 20, inlineDiffChars: 30000 },
  pr: { draft: false },
  // A command that prints a JSON array of tickets to offer in the control panel's Import dialog.
  import: { command: '' },
  telegram: { token: '', allowedChatIds: [], pairCode: '' },
  ntfy: { server: 'https://ntfy.sh', topic: '' },
  ui: { host: '127.0.0.1', port: 7878, notifyLabel: 'Notify' },
};

export const STATUSES = ['backlog', 'ready', 'running', 'needs_info', 'review', 'approved', 'pr_open', 'failed', 'rejected', 'done'];

function atomicWrite(p, data) {
  mkdirSync(join(p, '..'), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, p);
}
const readJson = (p, d) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);

export const loadConfig = () => deepMerge(DEFAULT_CONFIG, readJson(paths.config, {}));
export const saveConfig = (c) => atomicWrite(paths.config, c);
export const loadState = () => readJson(paths.state, { nextId: 1 });
export const saveState = (s) => atomicWrite(paths.state, s);

export const ticketDir = (id) => join(paths.tickets, id);
export const ticketFile = (id, name) => join(ticketDir(id), name);

export function getTicket(id) {
  const p = ticketFile(normId(id), 'ticket.json');
  if (!existsSync(p)) throw new Error(`no ticket ${id}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function saveTicket(t) {
  t.updatedAt = new Date().toISOString();
  atomicWrite(ticketFile(t.id, 'ticket.json'), t);
  return t;
}

// Read-modify-write so the CLI, the bot and the daemon don't clobber each other's fields.
export function updateTicket(id, fn) {
  const t = getTicket(id);
  fn(t);
  return saveTicket(t);
}

export function event(t, text) {
  t.history = [...(t.history || []), { at: new Date().toISOString(), text }].slice(-50);
}

export function listTickets(filter = {}) {
  if (!existsSync(paths.tickets)) return [];
  return readdirSync(paths.tickets)
    .filter((d) => existsSync(ticketFile(d, 'ticket.json')))
    .map((d) => JSON.parse(readFileSync(ticketFile(d, 'ticket.json'), 'utf8')))
    .filter((t) => (!filter.status || [].concat(filter.status).includes(t.status)) && (!filter.repo || t.repo === filter.repo))
    .sort(byCreation);
}

// A tracker key reaches shell commands through {ticket}, so only plain key characters are allowed.
export const KEY_RE = /^[A-Za-z0-9._-]+$/;
export const ticketKey = (t) => t.key || t.id;
// "{ticket}/{repo}" → values; unknown {names} stay as they are (shell braces, JSON).
export const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));

// Creation order = dependency order (autoRun relies on it). Ids can't sort across prefixes (T37 vs PIX-1).
const idNum = (id) => Number(String(id).match(/(\d+)$/)?.[1] || 0);
export const byCreation = (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || idNum(a.id) - idNum(b.id);

// Ticket ids are per repo: PIX-1, PIX-2 … Prefix = repos.<name>.prefix, else derived from the name: initials for
// multi-word names (saas-core → SC, binance-futures-monitor → BFM), else the first 3 letters (pixtune → PIX).
// Legacy global ids (T1, T2 …) stay valid.
export const PREFIX_RE = /^[A-Z][A-Z0-9]{0,7}$/;
export function repoPrefix(name, repo = {}) {
  if (repo.prefix) return repo.prefix;
  const words = name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const p = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 8) : (words[0] || '').slice(0, 3);
  return PREFIX_RE.test(p) ? p : 'T';
}

// "37" → T37 (legacy), "pix1" / "pix-1" → PIX-1, anything else upper-cased as is.
export function normId(id) {
  const s = String(id).trim().toUpperCase();
  if (/^\d+$/.test(s)) return `T${s}`;
  if (/^T\d+$/.test(s)) return s;
  const m = s.match(/^([A-Z][A-Z0-9]*?)-?(\d+)$/);
  return m ? `${m[1]}-${m[2]}` : s;
}

// mode "quick": no Claude plan — the ticket text itself is the brief for opencode (zero Claude tokens if the diff is small).
// key/url: the ticket in an external tracker; agents: per-stage agent overrides (e.g. from an import's routing).
// source: where it came from, e.g. ".wiki/plans/mvp.md#2" (plan import dedupes on it).
// kind "bug": same pipeline, but the planner also gets the screenshots and must name the root cause + a regression test.
export const SEVERITIES = ['low', 'medium', 'high', 'critical'];
export function createTicket({ repo, title, description = '', status = 'ready', mode = 'full', key = '', url = '', agents = {}, source = '', kind = 'feature', severity = '' }) {
  const cfg = loadConfig();
  const r = cfg.repos[repo];
  if (!r) throw new Error(`unknown repo "${repo}". Known: ${Object.keys(cfg.repos).join(', ') || 'none (kit hub repo add <path>)'}`);
  if (key && !KEY_RE.test(key)) throw new Error(`ticket key "${key}" may only contain letters, digits, ".", "_" and "-"`);
  if (key && listTickets({ repo }).some((x) => x.key === key && !['rejected', 'done'].includes(x.status))) throw new Error(`${key} already has an open ticket in ${repo}`);
  if (!['feature', 'bug'].includes(kind)) throw new Error(`unknown kind "${kind}" (feature | bug)`);
  if (kind === 'bug' && !SEVERITIES.includes(severity || 'medium')) throw new Error(`severity must be one of: ${SEVERITIES.join(', ')}`);
  const prefix = repoPrefix(repo, r);
  const state = loadState();
  state.counters = state.counters || {};
  let n = state.counters[prefix] || 0;
  do n++; while (existsSync(ticketDir(`${prefix}-${n}`))); // repos may share a prefix: never reuse an id
  state.counters[prefix] = n;
  saveState(state);
  const id = `${prefix}-${n}`;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
  const branch = fill(r.branch || 'kit/{id}-{slug}', { id, slug, ticket: key || id, repo });
  const t = {
    id, repo, title, description, status, mode, key, url, agents, source, kind, ...(kind === 'bug' ? { severity: severity || 'medium' } : {}),
    resume: 'plan', branch, worktree: '', baseSha: '',
    feedback: [], iterations: 0, cost: { claudeUsd: 0 }, pr: '', error: '',
    createdAt: new Date().toISOString(), history: [],
  };
  event(t, `created (${status})`);
  return saveTicket(t);
}

export function readText(id, name) {
  const p = ticketFile(id, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}
export const writeText = (id, name, text) => atomicWrite(ticketFile(id, name), text);
