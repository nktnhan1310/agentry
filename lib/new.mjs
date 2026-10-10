import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { report, sync } from './sync.mjs';
import { KIT, toPosix } from './util.mjs';

// `kit new <dir>`: git init (if needed) + first sync. Run it after the stack's own scaffolder so packs
// and build/test commands are detected and written into AGENTS.md.
export function newProject(dirArg, opts = {}) {
  if (!dirArg) throw new Error('usage: kit new <dir> [--packs a,b] [--tools claude,opencode]');
  const dir = resolve(dirArg);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git'))) {
    const r = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
  }
  const out = report(sync(dir, { packs: opts.packs, tools: opts.tools }), false);
  const cli = `node "${toPosix(join(KIT, 'bin', 'kit.mjs'))}"`;
  return `${out}
next:
  1. review AGENTS.md (build/test/lint) and .wiki/arch.md, then commit
  2. ${cli} hub repo add "${toPosix(dir)}"     # let the background loop take tickets
  3. /ticket <feature> in Claude Code or OpenCode, or ${cli} ui`;
}
