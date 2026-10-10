import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseFm, read, walk } from './util.mjs';

// Rough estimate of what Claude loads every session: agent/skill/command descriptions + root md files.
export function overhead(repo) {
  let chars = 0;
  let items = 0;
  const descs = [
    ...walk(join(repo, '.claude', 'agents'), { maxDepth: 0 }).map((f) => join(repo, '.claude', 'agents', f)),
    ...walk(join(repo, '.claude', 'commands')).map((f) => join(repo, '.claude', 'commands', f)),
    ...walk(join(repo, '.claude', 'skills'), { maxDepth: 1 }).filter((f) => f.endsWith('/SKILL.md')).map((f) => join(repo, '.claude', 'skills', f)),
  ];
  for (const f of descs.filter((f) => f.endsWith('.md'))) {
    const { data } = parseFm(read(f));
    chars += (data.name || '').length + (data.description || '').length + 10;
    items++;
  }
  for (const f of ['CLAUDE.md', 'AGENTS.md']) if (existsSync(join(repo, f))) chars += read(join(repo, f)).length;
  return { tokens: Math.round(chars / 4), items };
}
