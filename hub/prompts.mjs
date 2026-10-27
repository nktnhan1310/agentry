// Prompts for headless runs. Short, explicit output contracts so results are machine-checkable.
import { existsSync, readFileSync } from 'node:fs';

const qa = (t) => (t.answers || []).map((a, i) => `Q/A round ${i + 1}:\n${a}`).join('\n\n');
const key = (t) => t.key || t.id;
const NOTES_CHARS = 12000;

// Prefix for every Claude prompt: where to work (when Claude starts in a workspace, not the worktree)
// and the repo's notes (`wiki` files), capped so a long page can't flood the context.
export function context(t, repo = {}) {
  const parts = [];
  if (repo.workspace) parts.push(`Work only inside ${t.worktree}: read, edit and run commands there. Never modify ${repo.path} or any other checkout.`);
  let left = NOTES_CHARS;
  for (const f of [].concat(repo.wiki || [])) {
    const text = left > 0 && existsSync(f) ? readFileSync(f, 'utf8').slice(0, left) : '';
    if (!text) continue;
    left -= text.length;
    parts.push(`## Repo notes (${f})\n${text.trim()}`);
  }
  return parts.length ? `${parts.join('\n\n')}\n\n` : '';
}

export const prompts = {
  plan: (t, verifyCmds, ctx = '') => `${ctx}You are planning ticket ${key(t)} for this repository. Do NOT modify any files.

Ticket: ${t.title}
${t.description || '(no description)'}
${qa(t) ? `\nClarifications from the requester:\n${qa(t)}\n` : ''}
Context: read AGENTS.md and .wiki/index.md if they exist, then only the code you need. Reuse existing patterns.
Verification the pipeline will run afterwards: ${verifyCmds.length ? verifyCmds.map((c) => `\`${c}\``).join(', ') : 'none configured'}.

If the ticket is too ambiguous to implement safely, reply with the first line exactly "NEEDS_INFO", then at most 3 numbered questions (each with your suggested default answer), and nothing else.

Otherwise reply with ONLY a task brief (≤80 lines, no preamble) in exactly this format. Another, cheaper model will execute it with no other context:
# Task: <imperative title>
Goal: <1–2 lines>
Read first: <≤10 repo paths>
Change:
1. <precise step: file, function/signature, behaviour, edge cases>
Tests: <tests to add/update and where>
Constraints: no new dependencies unless listed here · match existing style · never commit or push · don't touch unrelated files
Acceptance: <exact commands that must pass> · <observable behaviour>
Report: ≤15 lines: files changed, acceptance results, open issues`,

  code: (t, brief = `.kit/handoff/${t.id}.md`, ctx = '') => `${ctx}Execute the task brief in ${brief} exactly. Follow its Constraints and any Fix/feedback sections at the end. Run its Acceptance commands. Never commit or push. Finish with a ≤15-line report: files changed, acceptance results, open issues.`,

  quickBrief: (t, verifyCmds) => `# Task: ${t.title}
Goal: ${t.description || t.title}
Read first: AGENTS.md, then only files needed for this change
Change:
1. Implement the goal with the smallest correct change. Add or update a test if behaviour changes.
Constraints: no new dependencies · match existing style · never commit or push · don't touch unrelated files
Acceptance: ${verifyCmds.length ? verifyCmds.map((c) => `\`${c}\``).join(' · ') : 'project builds and existing tests pass'}
Report: ≤15 lines: files changed, acceptance results, open issues
`,

  review: (t, stat, diff, ctx = '') => `${ctx}Review the changes for ticket ${key(t)} ("${t.title}"). Do NOT modify files.
${diff ? `The full diff is below. Do not re-read changed files; open other files only to check callers if essential.\n~~~diff\n${diff}\n~~~` : `Diff is large: inspect it with targeted reads of the changed files.\n${stat}`}

Follow .claude/skills/review/SKILL.md if it exists. Priority: correctness > security > data loss > contracts > tests > design.
The first line of your reply must be exactly "VERDICT: PASS" or "VERDICT: BLOCKING".
Then ≤25 lines of findings: \`path:line\` — problem — failure scenario — fix. BLOCKING only for bugs, security holes, data loss, or breaking changes. No praise.`,

  test: (t, stat, ctx = '') => `${ctx}Test the change for ticket ${key(t)} ("${t.title}") in ${t.worktree}. Do NOT modify any files; never commit, push, stash or switch branches.
Changed files (against ${String(t.baseSha).slice(0, 10)}):
${stat}

Run the smallest test scope that covers these files, from inside ${t.worktree}. Failures the repo notes list as known, or that also fail without this change, are pre-existing: report them separately; they don't fail the verdict.
The first line of your reply must be exactly "VERDICT: PASS", "VERDICT: FAIL" or "VERDICT: BLOCKED" (BLOCKED = the tests could not run at all, e.g. a missing dependency or service).
Then ≤30 lines: each command you ran with its pass/fail counts, then each new failure as \`test name\` — first error line.`,

  prBody: (t, summary) => `${t.description ? `${t.description}\n\n` : ''}${summary}
---
Ticket ${key(t)} · branch \`${t.branch}\` · Claude cost ≈ $${t.cost.claudeUsd}

🤖 Generated with [Claude Code](https://claude.com/claude-code)
`,
};
