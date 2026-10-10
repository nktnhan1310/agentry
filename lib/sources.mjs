import { basename, join } from 'node:path';
import { isDir, KIT, parseFm, read, readJson, walk } from './util.mjs';

// Repo overrides live in <repo>/.kit/local/{agents,commands,skills,hooks}: same name replaces, new name adds.
const layers = (repo, sub) => [join(KIT, 'core', sub), repo && join(repo, '.kit', 'local', sub)].filter(Boolean);

function loadMd(repo, sub) {
  const byName = new Map();
  for (const dir of layers(repo, sub)) {
    for (const f of walk(dir, { maxDepth: 0 }).filter((f) => f.endsWith('.md'))) {
      const { data, body } = parseFm(read(join(dir, f)));
      const name = data.name || basename(f, '.md');
      byName.set(name, { name, data, body, src: join(dir, f) });
    }
  }
  return [...byName.values()];
}

function loadSkillDir(dir, name) {
  return { name, files: walk(dir).map((rel) => ({ rel, content: read(join(dir, rel)) })) };
}

export function loadSources(repo, packs) {
  const skills = new Map();
  for (const dir of layers(repo, 'skills')) {
    if (!isDir(dir)) continue;
    for (const name of new Set(walk(dir).map((f) => f.split('/')[0]))) {
      if (isDir(join(dir, name))) skills.set(name, loadSkillDir(join(dir, name), name));
    }
  }
  for (const p of packs) {
    const dir = join(KIT, 'packs', p);
    if (isDir(dir) && !skills.has(p)) skills.set(p, loadSkillDir(dir, p));
  }

  const hooks = [];
  for (const dir of layers(repo, 'hooks')) {
    for (const rel of walk(dir, { maxDepth: 0 })) {
      const i = hooks.findIndex((h) => h.rel === rel);
      const h = { rel, content: read(join(dir, rel)) };
      i >= 0 ? (hooks[i] = h) : hooks.push(h);
    }
  }

  return {
    agents: loadMd(repo, 'agents'),
    commands: loadMd(repo, 'commands'),
    skills: [...skills.values()],
    hooks,
    settings: readJson(join(KIT, 'core', 'settings.json'), {}),
  };
}

export const forTool = (tool) => (x) => !x.data?.targets || x.data.targets.includes(tool);
