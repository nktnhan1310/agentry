// Turns loaded kit sources into what one repo installs: filtered by `install`, renamed by `namespace`
// and `roles`, with every cross-reference (backticked names, skill/hook paths, memory dir) rewritten to match.
import { basename } from 'node:path';
import { parseFm } from './util.mjs';

const KINDS = ['agents', 'skills', 'commands', 'hooks', 'packs'];
export const hookName = (rel) => basename(rel).replace(/\.\w+$/, '');
export const wants = (rule, name) => rule === undefined || rule === true || (Array.isArray(rule) && rule.includes(name));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Feature flags for conditional text in kit sources: {{#flag}}kept when on{{/flag}}, {{^flag}}kept when off{{/flag}}.
export const FLAGS = ['delegate'];
export const flagsFor = (cfg) => ({ delegate: (cfg.delegate?.engine || 'opencode') !== 'none' });
export const COND = /\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g;
export const applyFlags = (text, flags) => text.replace(COND, (_, op, k, body) => ((op === '#') === !!flags[k] ? body : ''));
// A source that needs a flag (`requires: delegate`) is not installed while that flag is off.
const needs = (x) => x.data?.requires || parseFm(x.files?.find((f) => f.rel === 'SKILL.md')?.content || '').data.requires;

export function select(src, cfg) {
  const inst = cfg.install || {};
  for (const k of Object.keys(inst)) if (![...KINDS, 'templates'].includes(k)) throw new Error(`install.${k}: unknown kind (${KINDS.join('|')}|templates)`);
  const ns = cfg.namespace ? `${cfg.namespace}-` : '';
  const roles = cfg.roles || {};
  const rootOff = (cfg.rootMd?.mode || 'block') === 'off';
  const memDir = cfg.memory?.dir || '.wiki';
  const flags = flagsFor(cfg);
  const met = (x) => !needs(x) || !!flags[needs(x)];

  // kit name → installed name (or the project's own agent/skill when mapped in `roles`).
  const names = {};
  for (const x of [...src.agents, ...src.skills]) names[x.name] = roles[x.name] || `${ns}${x.name}`;
  const keepAgent = (a) => !roles[a.name] && met(a) && wants(inst.agents, a.name);
  const keepSkill = (s) => !roles[s.name] && met(s) && wants(s.pack ? inst.packs : inst.skills, s.name);
  const keepHook = (h) => wants(inst.hooks, hookName(h.rel)) && !(rootOff && hookName(h.rel) === 'root-md-guard');
  const agents = src.agents.filter(keepAgent);
  const skills = src.skills.filter(keepSkill);
  const hooks = src.hooks.filter(keepHook);
  const commands = src.commands.filter((c) => wants(inst.commands, c.name));

  // Packs are referenced in prose, not as backticked names (`sql` in a checklist is a code token).
  const ticked = Object.entries(names).filter(([k, v]) => k !== v && !src.skills.find((s) => s.name === k && s.pack));
  const tickRe = ticked.length ? new RegExp('`(' + ticked.map(([k]) => esc(k)).join('|') + ')`', 'g') : null;
  const tickMap = Object.fromEntries(ticked);
  const memRe = /(?<![\w.])\.wiki(?=[/'"`\s)\]]|$)/gm;
  const rewrite = (text, md) => {
    let t = applyFlags(text, flags);
    for (const s of src.skills) if (names[s.name] !== s.name) t = t.replaceAll(`.claude/skills/${s.name}/`, `.claude/skills/${names[s.name]}/`);
    if (ns) for (const h of src.hooks) t = t.replaceAll(`.claude/hooks/${h.rel}`, `.claude/hooks/${ns}${h.rel}`);
    if (md && tickRe) t = t.replace(tickRe, (_, n) => `\`${tickMap[n]}\``);
    if (memDir !== '.wiki') t = t.replace(memRe, memDir);
    return t;
  };
  const isMd = (p) => /\.md$/i.test(p);

  // Settings: drop entries that point at hooks/skills this repo does not install, then rewrite paths.
  const s = structuredClone(src.settings || {});
  const droppedHooks = src.hooks.filter((h) => !keepHook(h)).map((h) => `.claude/hooks/${h.rel}`);
  const droppedSkills = src.skills.filter((x) => !keepSkill(x) && !roles[x.name]).map((x) => `.claude/skills/${x.name}/`);
  const live = (str) => !droppedHooks.some((d) => str.includes(d)) && !droppedSkills.some((d) => str.includes(d));
  for (const k of ['allow', 'deny']) if (s.permissions?.[k]) s.permissions[k] = s.permissions[k].filter(live);
  for (const [ev, groups] of Object.entries(s.hooks || {})) {
    s.hooks[ev] = groups.map((g) => ({ ...g, hooks: g.hooks.filter((h) => live(h.command)) })).filter((g) => g.hooks.length);
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }

  const out = {
    agents: agents.map((a) => ({ ...a, name: names[a.name], kitName: a.name, body: rewrite(a.body, true), data: { ...a.data, description: rewrite(a.data.description || '', true) } })),
    commands: commands.map((c) => ({
      ...c, kitName: c.name, body: rewrite(c.body, true),
      file: cfg.namespace ? { claude: `${cfg.namespace}/${c.name}`, opencode: `${ns}${c.name}` } : undefined,
    })),
    skills: skills.map((x) => ({
      ...x, name: names[x.name], kitName: x.name,
      files: x.files.map((f) => ({ ...f, content: renameSkill(rewrite(f.content, isMd(f.rel)), f.rel, x.name, names[x.name]) })),
    })),
    hooks: hooks.map((h) => ({ ...h, rel: `${ns}${h.rel}`, kitName: hookName(h.rel), content: rewrite(h.content, false) })),
    settings: JSON.parse(rewrite(JSON.stringify(s), false)),
  };

  // Installed name → kit name, for the manifest and the control panel.
  const installed = {};
  for (const x of [...out.agents, ...out.skills]) installed[x.name] = x.kitName;
  for (const h of out.hooks) installed[h.rel] = h.kitName;
  for (const c of out.commands) for (const f of Object.values(c.file || { a: c.name })) installed[f] = c.kitName;

  return { src: out, names, installed, notes: dangling(src, out, names, keepAgent, keepSkill, roles), rewrite };
}

function renameSkill(text, rel, from, to) {
  if (rel !== 'SKILL.md' || from === to) return text;
  return text.replace(/^(---\n[\s\S]*?^name:\s*)(\S+)$/m, (m, head, n) => (n === from ? `${head}${to}` : m));
}

// An excluded, unmapped agent/skill that installed files still mention is a broken pointer: say so.
function dangling(src, out, names, keepAgent, keepSkill, roles) {
  const gone = [...src.agents.filter((a) => !keepAgent(a) && !roles[a.name]), ...src.skills.filter((s) => !keepSkill(s) && !roles[s.name] && !s.pack)].map((x) => x.name);
  const texts = [...out.agents.map((a) => [a.name, a.body]), ...out.commands.map((c) => [c.name, c.body]),
    ...out.skills.flatMap((s) => s.files.filter((f) => f.rel === 'SKILL.md').map((f) => [s.name, f.content]))];
  const notes = [];
  for (const g of new Set(gone)) {
    const by = texts.filter(([, t]) => t.includes(`\`${names[g]}\``) || t.includes(`\`${g}\``)).map(([n]) => n);
    if (by.length) notes.push(`"${g}" is referenced by ${[...new Set(by)].join(', ')} but not installed: include it or map it in "roles"`);
  }
  return notes;
}
