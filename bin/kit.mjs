#!/usr/bin/env node
import { resolve } from 'node:path';
import { detectPacks, scan } from '../lib/detect.mjs';
import { doctor } from '../lib/doctor.mjs';
import { installGlobal } from '../lib/global.mjs';
import { hub } from '../hub/cli.mjs';
import { lint } from '../lib/lint.mjs';
import { loadConfig, report, sync } from '../lib/sync.mjs';

const BOOL = new Set(['dry', 'force', 'help', 'quick', 'backlog', 'no-open']);
const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith('--')) { pos.push(a); continue; }
  const [k, v] = a.slice(2).split('=');
  flags[k] = v ?? (BOOL.has(k) ? true : rest[++i]);
}

const HELP = `agentry — portable agents/skills/commands for Claude Code, OpenCode, Codex

  kit sync [repo] [--dry] [--force] [--packs a,b] [--tools claude,opencode,codex]
      Install/update kit files. Unmodified kit files are updated, local edits are kept.
  kit diff [repo]        Same as sync --dry
  kit doctor [repo]      Check budgets, drift, wiki health, delegate engine
  kit detect [repo]      Show which language packs would be installed
  kit lint               Validate kit sources against token budgets
  kit ui                 Open the local control panel (tickets, plans, diffs, repos, kit, settings)
  kit hub …             Local ticket loop + Telegram control (kit hub help)
  kit install-global     Add /kit-sync to ~/.claude/commands and ~/.config/opencode/commands

Repo overrides: .kit/config.json (deep-merged over kit.config.json), .kit/local/{agents,commands,skills,hooks}/`;

try {
  switch (cmd) {
    case 'sync':
    case 'diff': {
      const dry = cmd === 'diff' || !!flags.dry;
      console.log(report(sync(pos[0], { ...flags, dry }), dry));
      break;
    }
    case 'doctor': console.log(doctor(pos[0])); break;
    case 'detect': {
      const repo = resolve(pos[0] || '.');
      const cfg = loadConfig(repo);
      console.log(detectPacks(repo, cfg, scan(repo, cfg)).join(', ') || 'no packs matched');
      break;
    }
    case 'lint': {
      const out = lint();
      console.log(out);
      if (out !== 'lint: ok') process.exitCode = 1;
      break;
    }
    case 'ui': { console.log(await hub(['ui'], flags)); break; }
    case 'hub': { const out = await hub(pos, flags); if (out) console.log(out); break; }
    case 'install-global': console.log(installGlobal()); break;
    default: console.log(HELP);
  }
} catch (e) {
  console.error(`kit: ${e.message}`);
  process.exitCode = 1;
}
