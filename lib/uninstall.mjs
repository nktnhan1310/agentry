// `kit uninstall [repo] [--dry]`: remove what `kit sync` installed, using the manifest. Locally modified
// kit files are kept and listed; settings entries the kit added are taken back out; seeded docs stay.
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { excludeTarget, setExcludeBlock } from './footprint.mjs';
import { removeSettings } from './settings.mjs';
import { MANIFEST } from './sync.mjs';
import { pruneDirs, read, readJson, sha, write } from './util.mjs';

const isEmpty = (o) => !Object.keys(o).length;

export function uninstall(repoArg, { dry } = {}) {
  const repo = resolve(repoArg || '.');
  const m = readJson(join(repo, MANIFEST));
  if (!m) throw new Error(`${repo}: no ${MANIFEST}, nothing to uninstall`);
  const removed = [];
  const kept = [];
  const rm = (p) => { if (!dry) { rmSync(join(repo, p)); pruneDirs(join(repo, p), repo); } };

  for (const [p, h] of Object.entries(m.files || {})) {
    const full = join(repo, p);
    if (!existsSync(full)) continue;
    if (sha(read(full)) === h) { rm(p); removed.push(p); } else kept.push(p);
  }

  const settings = [];
  if (m.settings && existsSync(join(repo, m.settings.file))) {
    const { next, changes } = removeSettings(readJson(join(repo, m.settings.file), {}), m.settings.owned);
    settings.push(...changes);
    if (m.settings.created && isEmpty(next)) { rm(m.settings.file); settings.push(`${m.settings.file} deleted (the kit created it)`); }
    else if (changes.length && !dry) write(join(repo, m.settings.file), JSON.stringify(next, null, 2) + '\n');
  }

  // Untracked repos keep .kit/ hidden while the user's config/overrides remain in it.
  const keepKit = m.footprint === 'untracked' && ['config.json', 'local'].some((f) => existsSync(join(repo, '.kit', f)));
  const excl = setExcludeBlock(excludeTarget(repo), keepKit ? ['.kit/'] : [], { dry });
  rm(MANIFEST);

  const L = [`uninstall ${repo}${dry ? ' (dry run)' : ''}`, `  -${removed.length} kit files removed`];
  if (kept.length) L.push(`  ! modified locally, kept (delete by hand if unwanted): ${kept.join(', ')}`);
  if (settings.length) L.push('  settings:', ...settings.map((c) => `    ${c}`));
  if (!m.settings) L.push('  • manifest predates settings tracking: entries merged into .claude/settings.json were left in place');
  if (excl) L.push('  • .git/info/exclude: agentry block removed');
  if (m.seeds?.length) L.push(`  • seeded files are project content now and were kept: ${m.seeds.join(', ')}`);
  L.push('  • kept: .kit/config.json and .kit/local/ (your settings and overrides)');
  return L.join('\n');
}
