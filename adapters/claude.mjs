import { forTool } from '../lib/sources.mjs';
import { fm } from '../lib/util.mjs';

const TOOLS = { read: ['Read', 'Grep', 'Glob'], edit: ['Edit', 'Write'], bash: ['Bash'], web: ['WebFetch', 'WebSearch'] };

export const skillsRoot = '.claude/skills';

export function render(src, { emit, merge }) {
  for (const a of src.agents.filter(forTool('claude'))) {
    const tools = (a.data.tools || []).flatMap((t) => TOOLS[t] || [t]);
    emit(`.claude/agents/${a.name}.md`, fm({ name: a.name, description: a.data.description, tools: tools.join(', '), model: a.data.model || 'inherit' }) + a.body);
  }
  for (const c of src.commands.filter(forTool('claude'))) {
    emit(`.claude/commands/${c.name}.md`, fm({ description: c.data.description, 'argument-hint': c.data['argument-hint'] }) + c.body);
  }
  for (const s of src.skills) for (const f of s.files) emit(`${skillsRoot}/${s.name}/${f.rel}`, f.content);
  for (const h of src.hooks) emit(`.claude/hooks/${h.rel}`, h.content);
  merge('.claude/settings.json', src.settings);
}
