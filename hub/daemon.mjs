// Background loop: picks queued tickets, runs pipelines, executes approvals/cleanup, serves the Telegram bot.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { notify } from './notify.mjs';
import { approve, cleanup, runPipeline } from './pipeline.mjs';
import { cancel } from './proc.mjs';
import { event, listTickets, loadConfig, loadState, paths, saveTicket, updateTicket } from './store.mjs';
import { startUi } from './server.mjs';
import { startBot } from './telegram.mjs';

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const active = new Map(); // ticketId -> Promise

export function daemonPid() {
  if (!existsSync(paths.pid)) return 0;
  const pid = Number(readFileSync(paths.pid, 'utf8'));
  try { process.kill(pid, 0); return pid; } catch { return 0; }
}

function track(id, p) {
  active.set(id, p);
  p.catch((e) => log(`${id} crashed: ${e.stack || e}`)).finally(() => active.delete(id));
}

async function tick() {
  const cfg = loadConfig();
  const tickets = listTickets();

  for (const t of tickets) {
    if (t.status === 'running' && t.cancel) cancel(t.id);
    if (t.status === 'approved' && !active.has(t.id)) { log(`${t.id} approve`); track(t.id, approve(t.id, notify)); }
    if (['rejected', 'done'].includes(t.status) && t.worktree && !active.has(t.id)) { log(`${t.id} cleanup`); track(t.id, cleanup(t.id)); }
  }

  if (loadState().paused) return;
  const running = tickets.filter((t) => t.status === 'running').length;
  const busyRepos = new Set(tickets.filter((t) => t.status === 'running').map((t) => t.repo));
  let slots = cfg.limits.maxParallel - running;
  for (const t of tickets.filter((x) => x.status === 'ready')) {
    if (slots <= 0) break;
    if (busyRepos.has(t.repo) || active.has(t.id)) continue;
    updateTicket(t.id, (x) => { x.status = 'running'; event(x, 'started'); });
    busyRepos.add(t.repo);
    slots--;
    log(`${t.id} start (${t.repo}: ${t.title})`);
    track(t.id, runPipeline(t.id, notify));
  }
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
