// `kit adopt [repo] [--write]`: look at a repo that already has its own agents/skills/rules and propose a
// .kit/config.json that installs agentry next to them without collisions or noise. Read-only unless --write.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { excludeTarget, setExcludeBlock, trackedPaths } from './footprint.mjs';
import { loadSources } from './sources.mjs';
import { loadConfig, MANIFEST } from './sync.mjs';
import { lineCount, onPath, read, readJson, walk, write } from './util.mjs';

// Kit name → patterns for the project's equivalent. An exact name always wins; a pattern must match once.
const HINTS = {
  reviewer: /^(code-)?review(er)?$/, security: /^security(-auditor|-reviewer)?$/, explorer: /^(explore|scout)$/,
  planner: /^planner$/, tester: /^tester$/, implementer: /^(fullstack-)?developer$/,
  review: /^code-review$/, 'security-audit': /^security$/, debug: /^debugging$/, plan: /^planning$/, tdd: /^tdd$/,
};

function existing(repo, owned) {
  const own = (p) => !owned.has(p);
  const c = join(repo, '.claude');
  return {
    agents: walk(join(c, 'agents'), { maxDepth: 0 }).filter((f) => f.endsWith('.md') && own(`.claude/agents/${f}`)).map((f) => f.slice(0, -3)),
    skills: [...new Set(walk(join(c, 'skills'), { maxDepth: 1 }).filter((f) => f.endsWith('/SKILL.md') && own(`.claude/skills/${f}`)).map((f) => f.split('/')[0]))],
    commands: walk(join(c, 'commands')).filter((f) => f.endsWith('.md') && own(`.claude/commands/${f}`)).map((f) => f.slice(0, -3)),
    hooks: walk(join(c, 'hooks'), { maxDepth: 0 }).filter((f) => own(`.claude/hooks/${f}`)),
  };
}

function pickRole(name, candidates) {
  if (candidates.includes(name)) return name;
  const re = HINTS[name];
  const hits = re ? candidates.filter((n) => re.test(n)) : [];
  return hits.length === 1 ? hits[0] : null;
}

export function adopt(repoArg, { write: doWrite, force, engines: available } = {}) {
  const repo = resolve(repoArg || '.');
  const base = loadConfig(null);
  const m = readJson(join(repo, MANIFEST), { files: {} });
  const have = existing(repo, new Set(Object.keys(m.files)));
  const kit = loadSources(null, Object.keys(base.packs));
  const kitAgents = kit.agents.map((a) => a.name);
  const kitSkills = kit.skills.filter((s) => !s.pack).map((s) => s.name);
  const kitAll = { agents: kitAgents, skills: [...kitSkills, ...Object.keys(base.packs)], commands: kit.commands.map((c) => c.name), hooks: kit.hooks.map((h) => h.rel) };
  const clash = Object.fromEntries(Object.entries(kitAll).map(([k, v]) => [k, v.filter((n) => have[k].includes(n))]));
  const ownKit = have.agents.length + have.skills.length + have.commands.length;
  const claudeMd = existsSync(join(repo, 'CLAUDE.md')) ? lineCount(read(join(repo, 'CLAUDE.md'))) : null;
  const tracked = trackedPaths(repo, ['.claude', 'CLAUDE.md']);
  const git = !!excludeTarget(repo);

  const cfg = {};
  const why = [];
  if (ownKit) {
    cfg.namespace = 'ak';
    why.push(`namespace "ak": the repo has its own kit (${have.agents.length} agents, ${have.skills.length} skills, ${have.commands.length} commands); prefixed names never collide, now or after its next update`);
  }
  const roles = {};
  for (const n of kitAgents) { const r = pickRole(n, have.agents); if (r) roles[n] = r; }
  for (const n of kitSkills) { const r = pickRole(n, have.skills); if (r) roles[n] = r; }
  if (Object.keys(roles).length) {
    cfg.roles = roles;
    why.push(`roles: the kit uses the project's own ${Object.entries(roles).map(([k, v]) => `${v} (for ${k})`).join(', ')} instead of installing a second copy`);
  }
  if (git && (tracked.size || ownKit)) {
    cfg.footprint = 'untracked';
    why.push('footprint "untracked": kit files are hidden via .git/info/exclude and settings go to .claude/settings.local.json, so `git status` and PRs stay clean');
  } else if (!git) why.push('footprint stays "tracked": not a git repo');
  if (claudeMd !== null && claudeMd > base.budgets.rootMdLines) {
    cfg.rootMd = { mode: 'off' };
    why.push(`rootMd "off": CLAUDE.md has ${claudeMd} lines; the ${base.budgets.rootMdLines}-line guard would block every edit to it`);
  } else if (claudeMd !== null) {
    cfg.rootMd = { mode: 'warn' };
    why.push('rootMd "warn": CLAUDE.md exists; warn instead of blocking when it grows');
  }
  if (claudeMd !== null) {
    cfg.install = { templates: false };
    why.push('install.templates false: keep the existing CLAUDE.md as the only root file and seed no .wiki/ (set ["memory"] to seed one)');
  }
  if (claudeMd !== null && !existsSync(join(repo, 'AGENTS.md')) && !existsSync(join(repo, '.opencode'))) {
    cfg.tools = ['claude'];
    why.push('tools ["claude"]: no AGENTS.md or .opencode/ here, so OpenCode files would be unused');
  }

  const engines = Array.isArray(available) ? available : ['opencode', 'codex'].filter(onPath); // tests pass `engines`
  if (!engines.includes(base.delegate.engine)) {
    const engine = engines[0] || 'none';
    cfg.delegate = { engine };
    why.push(engine === 'none'
      ? 'delegate.engine "none": neither opencode nor codex is on PATH, so every task stays in Claude and the delegate agent/skill is not installed'
      : `delegate.engine "${engine}": ${base.delegate.engine} is not on PATH`);
  }

  const L = [`adopt ${repo}`];
  L.push(`  found: ${have.agents.length} agents · ${have.skills.length} skills · ${have.commands.length} commands · ${have.hooks.length} hooks not installed by agentry${claudeMd !== null ? ` · CLAUDE.md ${claudeMd} lines` : ''}${tracked.size ? ` · ${tracked.size} tracked files under .claude/` : ''}`);
  const cl = Object.entries(clash).filter(([, v]) => v.length).map(([k, v]) => `${k} ${v.join(', ')}`);
  if (cl.length) L.push(`  name collisions with the kit: ${cl.join(' · ')}`);
  L.push('  recommended .kit/config.json:', ...JSON.stringify(cfg, null, 2).split('\n').map((l) => `    ${l}`), '  why:', ...why.map((w) => `    - ${w}`));

  if (doWrite) {
    const dest = join(repo, '.kit', 'config.json');
    if (existsSync(dest) && !force) throw new Error('.kit/config.json exists: merge the suggestion by hand, or re-run with --force to replace it');
    write(dest, JSON.stringify(cfg, null, 2) + '\n');
    if (cfg.footprint === 'untracked') setExcludeBlock(excludeTarget(repo), ['.kit/']);
    L.push(`  wrote .kit/config.json${cfg.footprint === 'untracked' ? ' (hidden via .git/info/exclude)' : ''}`);
  }
  L.push(`  next: ${doWrite ? '' : 'kit adopt --write · '}kit diff (preview) · kit sync · undo any time with kit uninstall`);
  return L.join('\n');
}
