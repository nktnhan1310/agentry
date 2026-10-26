// `kit hub …` commands. Everything is local (~/.kit-hub); the daemon does the work.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { KIT } from '../lib/util.mjs';
import { actions } from './actions.mjs';
import { importCreate, importList, notifyTickets } from './stages.mjs';
import { createWithImages, fromFile } from './attachments.mjs';
import { daemonPid, serve } from './daemon.mjs';
import { e2eLog, runE2e } from './e2e.mjs';
import { repoCommands } from './pipeline.mjs';
import { getTicket, listTickets, loadConfig, normId, paths, PREFIX_RE, readText, repoPrefix, saveConfig } from './store.mjs';
import { uiUrl } from './server.mjs';
import { tg } from './telegram.mjs';

const HELP = `kit hub — local ticket loop (plan → code → verify → review → commit → STOP for your approval)

  setup     init · repo add <path> [--name n] [--base main] [--prefix PIX] [--setup "cmd"] [--verify "a && b" | none] · repo ls · repo rm <name>
            telegram <bot-token> · ntfy [topic] · autostart · config [key] [value]  (e.g. engines.plan.model sonnet)
  daemon    start · down · status · serve (foreground) · logs [n] · ui (open the control panel; starts the daemon)
  tickets   add <repo|path> "<title>" [--desc "…" | --desc-file f] [--key KEY-1] [--url u] [--quick] [--backlog] · ls [--status s] [--repo r] · show <id>
            bug <repo|path> "<title>" [--desc …] [--img a.png,b.png] [--severity low|medium|high|critical] [--key KEY-1] [--url u] [--backlog]
            run|plan|stop|approve|reject|reopen|done|verify <id> · changes|answer|broken <id> "<text>"
            import (list from import.command) · import <key…> [--backlog] · notify <id…> (repo notify command)
  e2e       e2e <repo>  run the Playwright suite on the latest base (no tokens); failing tests → bug tickets

  --quick: no Claude plan; opencode works from the ticket text (cheapest, for small changes).
  Data: ${paths.config.replace(/hub\.json$/, '')}  (override with KIT_HUB_DIR)`;

function defaultBase(path) {
  const r = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: path, encoding: 'utf8' });
  if (r.status === 0) return r.stdout.trim().replace(/^origin\//, '');
  return spawnSync('git', ['branch', '--show-current'], { cwd: path, encoding: 'utf8' }).stdout.trim() || 'main';
}

const fmt = (t) => `${t.id.padEnd(7)} ${t.status.padEnd(10)} ${t.repo.padEnd(18).slice(0, 18)} ${t.mode === 'quick' ? '⚡' : ' '} ${t.key ? `${t.key} · ` : ''}${t.title}`;

export async function hub([cmd = 'help', ...pos], flags) {
  const cfg = loadConfig();
  switch (cmd) {
    case 'init':
      if (!existsSync(paths.config)) saveConfig(cfg);
      return `hub config: ${paths.config}`;

    case 'repo': {
      const [sub, arg] = pos;
      if (sub === 'add') {
        const path = resolve(arg || '.');
        if (!existsSync(join(path, '.git'))) throw new Error(`${path} is not a git repo root`);
        const name = flags.name || basename(path);
        const prefix = flags.prefix?.toUpperCase() || cfg.repos[name]?.prefix;
        if (prefix && !PREFIX_RE.test(prefix)) throw new Error(`--prefix must be 1–8 letters/digits starting with a letter (e.g. PIX), got "${flags.prefix}"`);
        cfg.repos[name] = { path: path.replaceAll('\\', '/'), base: flags.base || defaultBase(path), ...(prefix ? { prefix } : {}) };
        if (flags.setup !== undefined) cfg.repos[name].setup = flags.setup;
        if (flags.verify) cfg.repos[name].verify = flags.verify === 'none' ? [] : flags.verify.split('&&').map((s) => s.trim()).filter(Boolean);
        saveConfig(cfg);
        const c = repoCommands(cfg.repos[name]);
        return `repo "${name}" → ${path} (base ${cfg.repos[name].base}, tickets ${repoPrefix(name, cfg.repos[name])}-1, -2 …)\n  setup:  ${c.setup || '(none)'}\n  verify: ${c.verify.join(' && ') || '(none — add --verify "…")'}`;
      }
      if (sub === 'rm') { delete cfg.repos[arg]; saveConfig(cfg); return `removed ${arg}`; }
      return Object.entries(cfg.repos).map(([n, r]) => `${n.padEnd(20)} ${repoPrefix(n, r).padEnd(6)} ${r.path} (${r.base})`).join('\n') || 'no repos';
    }

    case 'add': case 'bug': {
      const [repoArg, ...title] = pos;
      let repo = repoArg;
      let note = '';
      if (!cfg.repos[repo]) {
        // A path (e.g. "." from /ticket inside a repo): match a registered repo, or register it.
        const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: resolve(repoArg || '.'), encoding: 'utf8' }).stdout?.trim();
        if (!top) throw new Error(`unknown repo "${repoArg}" (${Object.keys(cfg.repos).join(', ') || 'none registered'})`);
        repo = Object.keys(cfg.repos).find((n) => resolve(cfg.repos[n].path) === resolve(top));
        if (!repo) {
          repo = basename(top);
          if (cfg.repos[repo]) throw new Error(`repo name "${repo}" is taken; run: kit hub repo add "${top}" --name <other>`);
          note = `${await hub(['repo', 'add', top], {})}\n`;
        }
      }
      const descFile = flags['desc-file'];
      const desc = descFile ? readFileSync(descFile, 'utf8') : flags.desc || '';
      if (descFile && /[\\/]\.kit[\\/]handoff[\\/]/.test(resolve(descFile))) rmSync(descFile); // /ticket draft; now stored in the ticket
      // --img: comma-separated screenshot paths (e.g. a failed e2e test's screenshot). Not downscaled here: keep them ≤1568px.
      const images = String(flags.img || '').split(',').map((s) => s.trim()).filter(Boolean).map((p) => fromFile(resolve(p)));
      const bug = cmd === 'bug';
      const t = createWithImages({ repo, title: title.join(' '), description: desc.trim(), status: flags.backlog ? 'backlog' : 'ready', mode: flags.quick ? 'quick' : 'full',
        key: flags.key || '', url: flags.url || '', kind: bug ? 'bug' : 'feature', severity: bug ? flags.severity || '' : '' }, images);
      return `${note}${t.key ? `${t.key} ` : ''}${t.id} ${bug ? `🐞 ${t.severity} ` : ''}${t.status}${t.mode === 'quick' ? ' (quick)' : ''}: ${t.title}${images.length ? ` · ${images.length} screenshot(s)` : ''}${daemonPid() ? '' : '\n(daemon not running: kit hub start)'}`;
    }
    case 'config': {
      // kit hub config engines.plan.model opus   ·   kit hub config (prints, token hidden)
      const [key, value] = pos;
      if (!key) return JSON.stringify({ ...cfg, telegram: { ...cfg.telegram, token: cfg.telegram.token ? '***' : '' } }, null, 2);
      const parts = key.split('.');
      const parent = parts.slice(0, -1).reduce((o, k) => (o[k] ??= {}), cfg);
      const last = parts.at(-1);
      if (value === undefined) return JSON.stringify(parent[last], null, 2);
      try { parent[last] = JSON.parse(value); } catch { parent[last] = value; }
      saveConfig(cfg);
      return `${key} = ${JSON.stringify(parent[last])}`;
    }
    case 'import': {
      if (pos.length) {
        const r = importCreate(pos, { backlog: !!flags.backlog });
        return [r.created.length ? `created ${r.created.join(' ')}` : 'created nothing', ...r.skipped.map((x) => `skipped ${x}`)].join('\n');
      }
      const list = await importList();
      return list.map((e) => `${e.key.padEnd(12)} ${e.repo.padEnd(22).slice(0, 22)} ${e.existing ? `(${e.existing}) ` : ''}${e.manual ? `[manual: ${e.manual}] ` : ''}${e.title}`).join('\n') || 'nothing to import';
    }
    case 'notify': return (await notifyTickets(pos)).text;
    case 'ls': return listTickets({ status: flags.status, repo: flags.repo }).map(fmt).join('\n') || 'no tickets';
    case 'show': {
      const t = getTicket(normId(pos[0]));
      return [fmt(t), `branch ${t.branch} · worktree ${t.worktree || '-'} · claude $${t.cost.claudeUsd} · iterations ${t.iterations}`,
        t.error && `error: ${t.error}`, t.pr && `PR: ${t.pr}`, readText(t.id, 'summary.md'),
        'history:', ...t.history.slice(-8).map((h) => `  ${h.at.slice(5, 16)} ${h.text}`)].filter(Boolean).join('\n');
    }
    case 'e2e': {
      const name = cfg.repos[pos[0]] ? pos[0] : Object.keys(cfg.repos).find((n) => resolve(cfg.repos[n].path) === resolve(pos[0] || '.'));
      if (!name) throw new Error(`unknown repo "${pos[0] || '.'}"`);
      const r = await runE2e(name);
      return r.status === 'error' ? `e2e ${name}: error\n${r.error}\nlog: ${e2eLog(name)}`
        : `e2e ${name} @ ${r.sha.slice(0, 7)}: ${r.passed} passed · ${r.failed} failed · ${r.flaky} flaky · ${r.skipped} skipped${r.filed.length ? `\nnew bugs: ${r.filed.join(' ')}` : ''}${r.still.length ? `\nstill failing: ${r.still.join(' ')}` : ''}${r.verified.length ? `\nverified fixed: ${r.verified.join(' ')}` : ''}\nlog: ${e2eLog(name)}`;
    }
    case 'run': case 'plan': case 'reopen': case 'stop': case 'approve': case 'reject': case 'done': case 'verify': case 'broken':
    case 'changes': case 'answer': {
      const t = actions[cmd](pos[0], pos.slice(1).join(' '));
      return `${t.id} → ${t.status}${t.cancel ? ' (cancelling)' : ''}${cmd === 'verify' ? ' (verified)' : cmd === 'broken' ? ` · new bug ${t.reopenedAs}` : ''}`;
    }

    case 'start': {
      if (daemonPid()) return `already running (pid ${daemonPid()}) · ui ${uiUrl()}`;
      if (!existsSync(paths.config)) saveConfig(cfg);
      const out = openSync(paths.log, 'a');
      const child = spawn(process.execPath, [join(KIT, 'bin', 'kit.mjs'), 'hub', 'serve'], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
      child.unref();
      return `daemon started (pid ${child.pid}) · ui ${uiUrl()} · log ${paths.log}`;
    }
    case 'ui': {
      const started = daemonPid() ? '' : `${await hub(['start'], {})}\n`;
      const url = uiUrl();
      const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
      if (!flags['no-open']) spawn(opener[0], opener[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return `${started}control panel: ${url}`;
    }
    case 'down': {
      const pid = daemonPid();
      if (!pid) return 'not running';
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(pid, 'SIGTERM');
      return `stopped ${pid} (running tickets resume on next start)`;
    }
    case 'status': {
      const pid = daemonPid();
      const n = (s) => listTickets({ status: s }).length;
      return `daemon: ${pid ? `running (pid ${pid})` : 'stopped'} · running ${n('running')} · queued ${n('ready')} · review ${n('review')} · needs_info ${n('needs_info')} · failed ${n('failed')}\n` +
        `telegram: ${cfg.telegram.token ? `${cfg.telegram.allowedChatIds.length} paired chat(s)` : 'off'} · ntfy: ${cfg.ntfy.topic ? `${cfg.ntfy.server}/${cfg.ntfy.topic}` : 'off'}`;
    }
    case 'serve': await serve(); return '';
    case 'logs': return existsSync(paths.log) ? readFileSync(paths.log, 'utf8').trimEnd().split('\n').slice(-(Number(pos[0]) || 30)).join('\n') : 'no log';

    case 'telegram': {
      const token = pos[0];
      if (!token) throw new Error('usage: kit hub telegram <token from @BotFather>');
      const me = await tg('getMe', {}, token);
      if (!me) throw new Error('token rejected by Telegram');
      cfg.telegram.token = token;
      cfg.telegram.pairCode = String(100000 + (randomBytes(4).readUInt32BE() % 900000));
      saveConfig(cfg);
      await tg('setMyCommands', { commands: [
        ['new', 'Queue a ticket: /new <repo> <title>'], ['quick', 'Small change, opencode only'], ['draft', 'Ticket into backlog'],
        ['list', 'Active tickets'], ['t', 'Show ticket: /t PIX-3'], ['status', 'Loop status'], ['repos', 'Configured repos'],
        ['pause', 'Pause the loop'], ['resume', 'Resume the loop'], ['help', 'Help'],
      ].map(([command, description]) => ({ command, description })) }, token);
      return `bot @${me.username} configured.\nOn your phone: open t.me/${me.username} and send:  /pair ${cfg.telegram.pairCode}\n(the daemon must be running: kit hub start)`;
    }
    case 'ntfy': {
      cfg.ntfy.topic = pos[0] || `kit-${randomBytes(9).toString('base64url')}`;
      saveConfig(cfg);
      return `ntfy topic set. In the ntfy app, subscribe to: ${cfg.ntfy.server}/${cfg.ntfy.topic}\n(only one-line status messages are sent, never code)`;
    }
    case 'autostart': {
      if (process.platform !== 'win32') return 'add `kit hub start` to your login items / crontab @reboot';
      const startup = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'agentry-hub.vbs');
      writeFileSync(startup, `CreateObject("WScript.Shell").Run """${process.execPath}"" ""${join(KIT, 'bin', 'kit.mjs')}"" hub start", 0, False\r\n`);
      return `autostart installed: ${startup}`;
    }
    default: return HELP;
  }
}
