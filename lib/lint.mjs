import { join } from 'node:path';
import { loadConfig } from './sync.mjs';
import { isDir, KIT, lineCount, parseFm, read, walk } from './util.mjs';

// Validates kit sources against token budgets before publishing.
export function lint() {
  const b = loadConfig().budgets;
  const errs = [];
  const check = (file, kind, maxLines, needName) => {
    const text = read(file);
    const { data, body } = parseFm(text);
    const rel = file.slice(KIT.length + 1).replaceAll('\\', '/');
    if (!data.description) errs.push(`${rel}: missing description`);
    else if (data.description.length > b.descChars) errs.push(`${rel}: description ${data.description.length} > ${b.descChars} chars`);
    if (needName && data.name !== needName) errs.push(`${rel}: name "${data.name}" must equal "${needName}"`);
    const n = lineCount(body);
    if (n > maxLines) errs.push(`${rel}: ${kind} body ${n} > ${maxLines} lines`);
  };

  for (const f of walk(join(KIT, 'core', 'agents'), { maxDepth: 0 })) check(join(KIT, 'core', 'agents', f), 'agent', b.agentLines);
  for (const f of walk(join(KIT, 'core', 'commands'), { maxDepth: 0 })) check(join(KIT, 'core', 'commands', f), 'command', b.commandLines);
  for (const [root, max] of [['core/skills', b.skillLines], ['packs', b.packLines]]) {
    const dir = join(KIT, root);
    for (const name of new Set(walk(dir).map((f) => f.split('/')[0]))) {
      if (!isDir(join(dir, name))) continue;
      check(join(dir, name, 'SKILL.md'), 'skill', max, name);
    }
  }
  const packs = Object.keys(loadConfig().packs);
  for (const p of packs) if (!isDir(join(KIT, 'packs', p))) errs.push(`kit.config.json: pack "${p}" has no packs/${p}/`);

  return errs.length ? `lint: ${errs.length} problem(s)\n${errs.map((e) => `  ✗ ${e}`).join('\n')}` : 'lint: ok';
}
