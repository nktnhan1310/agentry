import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyFlags, FLAGS } from './select.mjs';
import { loadConfig } from './sync.mjs';
import { isDir, KIT, lineCount, parseFm, read, readJson, walk } from './util.mjs';

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
  // Conditional text: only known flags, and nothing left over once resolved either way (= balanced).
  const texts = [...walk(join(KIT, 'core')).map((f) => `core/${f}`), ...walk(join(KIT, 'packs')).map((f) => `packs/${f}`)].filter((f) => /\.(md|json)$/.test(f));
  for (const rel of texts) {
    const t = read(join(KIT, rel));
    for (const m of t.matchAll(/\{\{[#^/](\w+)\}\}/g)) if (!FLAGS.includes(m[1])) errs.push(`${rel}: unknown flag "${m[1]}" (known: ${FLAGS.join(', ')})`);
    if ([true, false].some((on) => /\{\{[#^/]\w+\}\}/.test(applyFlags(t, Object.fromEntries(FLAGS.map((f) => [f, on])))))) errs.push(`${rel}: unbalanced {{#flag}}…{{/flag}} markers`);
  }

  // Release: one version in package.json and kit.config.json, and a CHANGELOG section for it.
  const version = loadConfig().version;
  const pkg = readJson(join(KIT, 'package.json'), {});
  if (pkg.version !== version) errs.push(`version: package.json ${pkg.version} ≠ kit.config.json ${version} (bump both on release)`);
  const log = existsSync(join(KIT, 'CHANGELOG.md')) ? read(join(KIT, 'CHANGELOG.md')) : '';
  if (!log.includes(`## [${version}]`)) errs.push(`CHANGELOG.md: no "## [${version}]" section for the current version`);

  const packs = Object.keys(loadConfig().packs);
  for (const p of packs) if (!isDir(join(KIT, 'packs', p))) errs.push(`kit.config.json: pack "${p}" has no packs/${p}/`);

  return errs.length ? `lint: ${errs.length} problem(s)\n${errs.map((e) => `  ✗ ${e}`).join('\n')}` : 'lint: ok';
}
