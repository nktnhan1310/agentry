// `footprint: "untracked"`: kit files live in the repo but are hidden through a managed block in
// .git/info/exclude (shared by every worktree), so `git status` stays clean and nothing gets committed.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { read, write } from './util.mjs';

const BEGIN = '# >>> agentry (managed by `kit sync`; `kit uninstall` removes it)';
const END = '# <<< agentry';
const blockRe = new RegExp(`\\n?${BEGIN.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&')}\\n[\\s\\S]*?${END}\\n?`, 'g');

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

// { file, prefix } of the repo's exclude file, or null outside git. prefix = repo path inside the git root.
export function excludeTarget(repo) {
  try {
    const [common, prefix = ''] = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-prefix']).split('\n');
    return { file: join(common.trim(), 'info', 'exclude'), prefix: prefix.trim() };
  } catch { return null; }
}

// Replace the managed block with `paths` (repo-relative; a trailing / means a directory). [] removes it.
export function setExcludeBlock(target, paths, { dry } = {}) {
  if (!target) return false;
  const cur = existsSync(target.file) ? read(target.file) : '';
  const base = cur.replace(blockRe, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
  const lines = [...new Set(paths)].sort().map((p) => `/${target.prefix}${p}`);
  const next = lines.length ? `${base}${base && !base.endsWith('\n') ? '\n' : ''}${BEGIN}\n${lines.join('\n')}\n${END}\n` : base;
  if (next === cur) return false;
  if (!dry) write(target.file, next);
  return true;
}

// Which of these repo-relative paths (or path prefixes) git already tracks; excludes cannot hide those.
export function trackedPaths(repo, specs) {
  if (!specs.length) return new Set();
  try { return new Set(git(repo, ['ls-files', '-z', '--', ...specs]).split('\0').filter(Boolean)); } catch { return new Set(); }
}
