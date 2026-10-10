import { forTool } from '../lib/sources.mjs';
import { fm } from '../lib/util.mjs';

// OpenCode also reads .claude/skills, so skills are only emitted here when the claude adapter is off.
export function render(src, { emit, cfg }) {
  const skillsRoot = cfg.tools.includes('claude') ? '.claude/skills' : '.opencode/skills';
  const fix = (s) => s.replaceAll('.claude/skills/', `${skillsRoot}/`);
  const models = cfg.models?.opencode || {};

  for (const a of src.agents.filter(forTool('opencode'))) {
    const t = a.data.tools || [];
    const bash = t.includes('bash')
      ? ['  bash:', '    "*": allow', ...cfg.safety.denyBash.map((p) => `    ${JSON.stringify(p)}: deny`)]
      : ['  bash: deny'];
    const head = fm({ description: a.data.description, mode: a.data.mode || 'subagent', model: models[a.data.model] }).replace(/---\n$/, '');
    const perm = ['permission:', `  edit: ${t.includes('edit') ? 'allow' : 'deny'}`, ...bash, `  webfetch: ${t.includes('web') ? 'allow' : 'deny'}`];
    emit(`.opencode/agents/${a.name}.md`, `${head}${perm.join('\n')}\n---\n${fix(a.body)}`);
  }
  for (const c of src.commands.filter(forTool('opencode'))) {
    emit(`.opencode/commands/${c.name}.md`, fm({ description: c.data.description }) + fix(c.body));
  }
  if (skillsRoot !== '.claude/skills') {
    for (const s of src.skills) for (const f of s.files) emit(`${skillsRoot}/${s.name}/${f.rel}`, fix(f.content));
  }
}
