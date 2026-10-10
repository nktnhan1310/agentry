// Codex reads skills from .agents/skills and rules from AGENTS.md; it has no file-defined subagents.
// Note: OpenCode reads both .claude/skills and .agents/skills, so enabling codex alongside claude
// shows OpenCode duplicate skills. Set OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 in that case.
export function render(src, { emit }) {
  for (const s of src.skills) {
    for (const f of s.files) emit(`.agents/skills/${s.name}/${f.rel}`, f.content.replaceAll('.claude/skills/', '.agents/skills/'));
  }
}
