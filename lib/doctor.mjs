import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lintWiki } from '../core/skills/wiki/scripts/wiki-lint.mjs';
import { overhead } from './overhead.mjs';
import { loadConfig } from './sync.mjs';
import { lineCount, read, readJson, sha, walk } from './util.mjs';

const onPath = (bin) => {
  try { execSync(process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; }
};

export function doctor(repoArg) {
  const repo = resolve(repoArg || '.');
  const cfg = loadConfig(repo);
  const issues = [];
  const ok = [];

  const max = cfg.budgets.rootMdLines;
  const rootMds = walk(repo, { maxDepth: 3, ignore: cfg.detect.ignoreDirs }).filter((f) => /(^|\/)(CLAUDE|AGENTS)\.md$/.test(f));
  for (const f of rootMds) {
    const n = lineCount(read(join(repo, f)));
    (n > max ? issues : ok).push(`${f}: ${n}/${max} lines`);
  }
  if (existsSync(join(repo, 'CLAUDE.md')) && !/^@AGENTS\.md/m.test(read(join(repo, 'CLAUDE.md')))) issues.push('CLAUDE.md should start with @AGENTS.md');

  const m = readJson(join(repo, '.kit', 'manifest.json'));
  if (!m) issues.push('not synced: run `kit sync`');
  else {
    if (m.kit !== cfg.version) issues.push(`kit ${m.kit} installed, ${cfg.version} available: run \`kit sync\``);
    const modified = Object.entries(m.files).filter(([p, h]) => existsSync(join(repo, p)) && sha(read(join(repo, p))) !== h).map(([p]) => p);
    const missing = Object.keys(m.files).filter((p) => !existsSync(join(repo, p)));
    if (modified.length) issues.push(`locally modified kit files (move edits to .kit/local/): ${modified.join(', ')}`);
    if (missing.length) issues.push(`deleted kit files (re-sync restores): ${missing.join(', ')}`);
    const engine = m.delegate?.engine;
    if (engine && !onPath(engine)) issues.push(`delegate engine "${engine}" not on PATH`);
    else if (engine) ok.push(`delegate engine: ${engine}`);
  }

  if (existsSync(join(repo, '.wiki'))) {
    const w = lintWiki(join(repo, '.wiki'), cfg.budgets, { fix: false, repo });
    w.length ? issues.push(...w.map((x) => `wiki: ${x}`)) : ok.push('wiki: clean');
  } else issues.push('no .wiki/: run `kit sync` to seed it');

  const o = overhead(repo);
  ok.push(`always-loaded context ≈ ${o.tokens} tokens (${o.items} descriptions + root md)`);

  return [`doctor ${repo}`, ...ok.map((x) => `  ✓ ${x}`), ...issues.map((x) => `  ✗ ${x}`)].join('\n') + (issues.length ? '' : '\n  all good');
}
