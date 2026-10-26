// Child-process runner with log files, tails, timeouts and tree-kill (Windows-safe).
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const running = new Map(); // ticketId -> Set<ChildProcess>

export function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
}

export function cancel(ticketId) {
  for (const c of running.get(ticketId) || []) killTree(c);
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/**
 * run(cmd, args, { cwd, shell, log, logLine, timeoutMin, ticketId, input })
 * → { code, out (full stdout), tail (last lines of stdout+stderr), timedOut }
 */
export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    if (opts.log) mkdirSync(dirname(opts.log), { recursive: true });
    const log = opts.log ? createWriteStream(opts.log, { flags: 'a' }) : null;
    log?.write(`$ ${cmd} ${args.join(' ')}\n`);
    // With a shell, pass one pre-joined command string (Node deprecates args + shell:true).
    const child = spawn(opts.shell ? [cmd, ...args].join(' ') : cmd, opts.shell ? [] : args, {
      cwd: opts.cwd, shell: !!opts.shell, windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, ...opts.env },
      stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (opts.ticketId) {
      if (!running.has(opts.ticketId)) running.set(opts.ticketId, new Set());
      running.get(opts.ticketId).add(child);
    }
    if (opts.input) { child.stdin.write(opts.input); child.stdin.end(); }
    let out = '';
    let partial = '';
    const lines = [];
    const take = (isOut) => (buf) => {
      let s = buf.toString();
      if (isOut) out += s;
      // logLine(line) → readable text for the log/tail (stdout only, line-buffered), e.g. stream-json events.
      if (isOut && opts.logLine) {
        const parts = (partial + s).split(/\r?\n/);
        partial = parts.pop();
        s = parts.map((l) => (l.trim() ? opts.logLine(l) || '' : '')).join('');
        if (!s) return;
      }
      log?.write(s);
      for (const l of stripAnsi(s).split(/\r?\n/)) if (l.trim()) lines.push(l);
      if (lines.length > 500) lines.splice(0, lines.length - 500);
    };
    child.stdout.on('data', take(true));
    child.stderr.on('data', take(false));
    let timedOut = false;
    const timer = opts.timeoutMin ? setTimeout(() => { timedOut = true; killTree(child); }, opts.timeoutMin * 60_000) : null;
    let finished = false;
    const done = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      running.get(opts.ticketId)?.delete(child);
      log?.end(`\n[exit ${code}${timedOut ? ', timeout' : ''}]\n`);
      resolve({ code: timedOut ? 124 : code ?? 1, out, tail: lines.slice(-60).join('\n'), timedOut });
    };
    child.on('error', (e) => { lines.push(String(e.message)); done(127); });
    child.on('close', done);
  });
}

export const git = (cwd, args, opts = {}) => run('git', args, { cwd, ...opts });
