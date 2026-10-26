// Background loop: picks queued tickets, runs pipelines, executes approvals/cleanup, serves the Telegram bot.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { lastRun, runE2e } from './e2e.mjs';
import { notify } from './notify.mjs';
import { approve, checkMerged, cleanup, runPipeline } from './pipeline.mjs';
import { cancel } from './proc.mjs';
import { event, listTickets, loadConfig, loadState, paths, saveTicket, updateTicket } from './store.mjs';
import { startUi } from './server.mjs';
import { startBot } from './telegram.mjs';

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const active = new Map(); // ticketId -> Promise
const mergeChecked = new Map(); // ticketId -> last auto-merge check (ms)

export function daemonPid() {
  if (!existsSync(paths.pid)) return 0;
  const pid = Number(readFileSync(paths.pid, 'utf8'));
  try { process.kill(pid, 0); return pid; } catch { return 0; }
}

function track(id, p) {
  active.set(id, p);
  p.catch((e) => log(`${id} crashed: ${e.stack || e}`)).finally(() => active.delete(id));
}

// Waiting on GitHub, or refused (e.g. conflicts). Tickets refused before "failed" existed kept '' plus the error.
export const watchMerge = (t) => ['pending', 'failed'].includes(t.autoMerge) || (!t.autoMerge && /^auto-merge failed/.test(t.error || ''));

async function tick() {
  const cfg = loadConfig();
  const tickets = listTickets();

  for (const t of tickets) {
    if (t.status === 'running' && t.cancel) cancel(t.id);
    if (t.status === 'approved' && !active.has(t.id)) { log(`${t.id} approve`); track(t.id, approve(t.id, notify)); }
    if (['rejected', 'done'].includes(t.status) && t.worktree && !t.cleanupFailed && !active.has(t.id)) { log(`${t.id} cleanup`); track(t.id, cleanup(t.id)); }
    // GitHub auto-merge waits for checks; look every 2 min, close the ticket once it lands, resolve conflicts that block it.
    // Auto-run repos also need to notice a PR merged by hand, so the next backlog ticket can start.
    if (t.status === 'pr_open' && (watchMerge(t) || cfg.repos[t.repo]?.autoRun) && !active.has(t.id) && Date.now() - (mergeChecked.get(t.id) || 0) > 120_000) {
      mergeChecked.set(t.id, Date.now()); track(t.id, checkMerged(t.id, notify));
    }
  }

  if (loadState().paused) return;
  // Scheduled e2e runs (repos.<name>.e2e.everyHours): shell only, no tokens; failures become bug tickets.
  for (const [name, r] of Object.entries(cfg.repos)) {
    const every = Number(r.e2e?.everyHours) || 0;
    if (!every || r.paused || active.has(`e2e:${name}`)) continue;
    const last = lastRun(name);
    if (last && (last.status === 'running' || Date.now() - new Date(last.at) < every * 3600_000)) continue;
    log(`e2e ${name} (every ${every}h)`);
    track(`e2e:${name}`, runE2e(name, notify).then((x) => log(`e2e ${name}: ${x.status} · ${x.passed} passed · ${x.failed} failed${x.filed.length ? ` → ${x.filed.join(' ')}` : ''}${x.error ? ` · ${x.error.split('\n')[0]}` : ''}`)));
  }
  for (const t of autoRun(tickets, cfg).start) {
    updateTicket(t.id, (x) => { x.status = 'ready'; x.error = ''; x.planOnly = false; event(x, 'queued by auto-run'); });
    log(`${t.id} auto-run queued (${t.repo}: ${t.title})`);
  }
  for (const t of schedule(listTickets(), cfg, false, active).start) {
    updateTicket(t.id, (x) => { x.status = 'running'; event(x, 'started'); });
    log(`${t.id} start${t.planOnly ? ' (plan only)' : ''} (${t.repo}: ${t.title})`);
    track(t.id, runPipeline(t.id, notify));
  }
}

// Auto-run repos (repos.<name>.autoRun): once nothing of the repo is in flight, queue its oldest backlog ticket.
// Tickets are created in dependency order, so each one branches from a base that already has the previous one merged.
// A failed or needs_info ticket holds the line until you deal with it (run, answer or reject).
const IN_FLIGHT = ['ready', 'running', 'needs_info', 'review', 'approved', 'pr_open', 'failed'];
export function autoRun(tickets, cfg) {
  const start = [];
  const wait = {};
  for (const [name, r] of Object.entries(cfg.repos)) {
    if (!r.autoRun || r.paused) continue;
    const mine = tickets.filter((t) => t.repo === name);
    const next = mine.find((t) => t.status === 'backlog');
    if (!next) continue;
    const busy = mine.find((t) => IN_FLIGHT.includes(t.status));
    if (busy) wait[next.id] = `auto-run: next after ${busy.id} (${busy.status.replace('_', ' ')})`;
    else start.push(next);
  }
  return { start, wait };
}

// Which queued tickets start now, and why the rest wait (the UI shows the reason).
// Coding: one ticket per repo, limits.maxParallel overall. Plan-only runs just read code into their own
// worktree, so they run alongside coding, up to limits.maxPlanning (0 = treat them like coding tickets).
export function schedule(tickets, cfg, paused, active = new Map()) {
  const start = [];
  const wait = {};
  const run = tickets.filter((t) => t.status === 'running');
  const planMax = cfg.limits.maxPlanning ?? 2;
  let planSlots = planMax - run.filter((t) => t.planOnly && planMax > 0).length;
  let slots = cfg.limits.maxParallel - run.filter((t) => !(t.planOnly && planMax > 0)).length;
  const busy = new Map(run.filter((t) => !(t.planOnly && planMax > 0)).map((t) => [t.repo, t.id]));
  for (const t of tickets.filter((x) => x.status === 'ready')) {
    if (active.has(t.id)) continue;
    if (paused) { wait[t.id] = 'loop paused'; continue; }
    if (cfg.repos[t.repo]?.paused) { wait[t.id] = 'repo paused'; continue; }
    if (t.planOnly && planMax > 0) {
      if (planSlots <= 0) { wait[t.id] = `waiting: ${planMax} plan(s) already running`; continue; }
      planSlots--; start.push(t); continue;
    }
    if (busy.has(t.repo)) { wait[t.id] = `waiting for ${busy.get(t.repo)} (one coding ticket per repo)`; continue; }
    if (slots <= 0) { wait[t.id] = `waiting for a free slot (${cfg.limits.maxParallel} at a time)`; continue; }
    slots--; busy.set(t.repo, t.id); start.push(t);
  }
  return { start, wait };
}

export async function serve() {
  const other = daemonPid();
  if (other && other !== process.pid) throw new Error(`daemon already running (pid ${other})`);
  writeFileSync(paths.pid, String(process.pid));
  const bye = () => { try { unlinkSync(paths.pid); } catch { /* gone */ } process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);

  // Tickets left "running" by a crash/restart go back to the queue and resume from their last stage.
  for (const t of listTickets({ status: 'running' })) {
    t.status = 'ready'; t.cancel = false; event(t, 'requeued after daemon restart'); saveTicket(t);
  }
  log(`hub daemon up (pid ${process.pid}) data=${paths.config.replace(/hub\.json$/, '')}`);
  startBot(log);
  startUi(log);
  for (;;) {
    try { await tick(); } catch (e) { log(`tick error: ${e.stack || e}`); }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
