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

// Bug tickets: screenshots first (they are the evidence), then root cause before fix. The coder never sees the
// images, so the brief has to carry what they show in words.
const bugPlan = (t, images) => `
This is a BUG report (severity: ${t.severity || 'medium'}).${images.length ? `
Screenshots from the reporter: ${images.join(', ')}. Read each one with the Read tool BEFORE exploring code; read each only once.` : ''}
Find the root cause, not just the symptom: trace from the visible failure to the code that produces it. If you cannot pin it down from the code, ask (NEEDS_INFO) rather than guess.
In the brief, add these lines after Goal:
Symptom: <what the reporter sees${images.length ? ', described from the screenshots in words (the coder cannot see images)' : ''}>
Root cause: <path:line — why it happens>
and make the first Tests item a regression test that fails before the fix and passes after.
`;

export const prompts = {
  plan: (t, verifyCmds, ctx = '', images = []) => `${ctx}You are planning ticket ${key(t)} for this repository. Do NOT modify any files.

Ticket: ${t.title}
${t.description || '(no description)'}
${qa(t) ? `\nClarifications from the requester:\n${qa(t)}\n` : ''}${t.kind === 'bug' ? bugPlan(t, images) : ''}
Context: read AGENTS.md and .wiki/index.md if they exist, then only the code you need. Reuse existing patterns.
Verification the pipeline will run afterwards: ${verifyCmds.length ? verifyCmds.map((c) => `\`${c}\``).join(', ') : 'none configured'}.

If the ticket is too ambiguous to implement safely, reply with the first line exactly "NEEDS_INFO", then ONLY a JSON array of at most 3 questions, nothing else:
[{"q": "<the question, with the context needed to answer it>", "options": ["<complete answer A>", "<complete answer B>"], "default": 0}]
Give 2–4 short, mutually exclusive options per question; "default" is the index of the option you recommend.

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

  quickBrief: (t, verifyCmds, images = []) => `# Task: ${t.kind === 'bug' ? 'Fix: ' : ''}${t.title}
Goal: ${t.description || t.title}
Read first: AGENTS.md, then only files needed for this change${images.length ? `\nScreenshots: ${images.join(', ')}` : ''}
Change:
1. ${t.kind === 'bug' ? 'Find the root cause, add a regression test that fails before the fix, then make the smallest correct fix.' : 'Implement the goal with the smallest correct change. Add or update a test if behaviour changes.'}
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

  resolve: (t, base, files, extra = '') => `Ticket ${t.id} ("${t.title}") has an open PR. Merging the latest ${base} into its branch stopped on conflicts in:
${files.map((f) => `- ${f}`).join('\n')}

What the ticket changes: ${(t.description || t.title).slice(0, 800)}

Resolve every conflict in these files. For each <<<<<<< / ======= / >>>>>>> block, read both sides (\`git log -p -3 origin/${base} -- <file>\` shows what landed on ${base}) and keep the intent of BOTH: the ticket's change and the work on ${base}. Pick one side only when the other is truly superseded. Remove every conflict marker.
Rules: edit only the conflicted files, plus the smallest follow-up the combined code needs (e.g. an import or a renamed call). Never commit, push, reset, checkout, or abort the merge.${extra}
Finish with ≤10 lines: per file, how you combined the two sides.`,

  tickets: (goal, existing) => `You are breaking work into tickets for this repository. Do NOT modify any files.

Goal from the user:
${goal}

Context: read AGENTS.md, .wiki/index.md, .wiki/arch.md and .wiki/plans/*.md if they exist, then only the code you need to size the work.
${existing ? `Tickets that already exist (do not duplicate them; you may depend on them):\n${existing}\n` : ''}
Split the goal into 2–10 small tickets in dependency order. Each must be shippable on its own and leave build, tests and lint green.
Reply with ONLY a JSON array, no prose, no code fence:
[{"title": "<imperative, ≤70 chars>", "description": "Goal: <1–2 lines>\\nAcceptance: <observable checks and tests>\\nFiles: <likely paths>\\nDepends on: <earlier ticket titles or none>"}]`,

  notes: (t, stat, worker, verifyReport, review) => `Ticket ${t.id} is finished. Write a short report about it for two audiences. Do NOT modify or read files; use only what is below.

Ticket: ${t.title}
${t.description || '(no description)'}

Files changed:
${stat}

Checks:
${verifyReport || '(none)'}

Code review:
${(review || '(skipped)').slice(0, 2000)}

Coder report:
${(worker || '(none)').slice(-2000)}

Reply with ONLY this, no preamble:
## For everyone
<2–3 sentences for non-technical readers (product, business): what changed and why it matters to users. No file names, code terms or jargon.>
## For engineers
<3–5 "- " bullets: the key code changes, anything risky or worth a closer look, and how to test it.>`,

  prBody: (t, summary, notes = '') => `${t.description ? `${t.description}\n\n` : ''}${notes ? `${notes.trim()}\n\n` : ''}${summary}
---
Ticket ${key(t)} · branch \`${t.branch}\` · Claude cost ≈ $${t.cost.claudeUsd}

🤖 Generated with [Claude Code](https://claude.com/claude-code)
`,
};
