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
  // Opus writes the brief once per ticket (a sharper brief saves fix loops); sonnet reviews; free opencode codes and fixes.
  // `agent` = a Claude Code agent (`claude --agent`) for that stage; repo `agents.<stage>` and ticket `agents.<stage>` override it.
  engines: {
    plan: { tool: 'claude', model: 'opus', agent: '' },
    code: { tool: 'opencode', model: '', agent: '' },
    review: { tool: 'claude', model: 'sonnet', agent: '' },
    test: { tool: 'claude', model: '', agent: '' },
  },
  limits: { maxParallel: 1, fixIterations: 3, reviewRounds: 1, stageTimeoutMin: 30, claudeBudgetUsd: 1 },
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
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

// A tracker key reaches shell commands through {ticket}, so only plain key characters are allowed.
export const KEY_RE = /^[A-Za-z0-9._-]+$/;
export const ticketKey = (t) => t.key || t.id;
// "{ticket}/{repo}" → values; unknown {names} stay as they are (shell braces, JSON).
export const fill = (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));

export const normId = (id) => (/^\d+$/.test(String(id)) ? `T${id}` : String(id).toUpperCase());

// mode "quick": no Claude plan — the ticket text itself is the brief for opencode (zero Claude tokens if the diff is small).
// key/url: the ticket in an external tracker; agents: per-stage agent overrides (e.g. from an import's routing).
export function createTicket({ repo, title, description = '', status = 'ready', mode = 'full', key = '', url = '', agents = {} }) {
  const cfg = loadConfig();
  const r = cfg.repos[repo];
  if (!r) throw new Error(`unknown repo "${repo}". Known: ${Object.keys(cfg.repos).join(', ') || 'none (kit hub repo add <path>)'}`);
  if (key && !KEY_RE.test(key)) throw new Error(`ticket key "${key}" may only contain letters, digits, ".", "_" and "-"`);
  if (key && listTickets({ repo }).some((x) => x.key === key && !['rejected', 'done'].includes(x.status))) throw new Error(`${key} already has an open ticket in ${repo}`);
  const state = loadState();
  const id = `T${state.nextId++}`;
  saveState(state);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
  const branch = fill(r.branch || 'kit/{id}-{slug}', { id, slug, ticket: key || id, repo });
  const t = {
    id, repo, title, description, status, mode, key, url, agents,
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
