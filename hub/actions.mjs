// Human actions on tickets. CLI and Telegram only change state; the daemon does the work.
import { attachmentPath, createWithImages, fromFile, listAttachments } from './attachments.mjs';
import { event, getTicket, normId, readText, updateTicket } from './store.mjs';

const fixedBug = (t, action) => {
  if (t.kind !== 'bug') throw new Error(`${t.id} is not a bug`);
  guard(t, ['done'], action);
};

const guard = (t, allowed, action) => {
  if (!allowed.includes(t.status)) throw new Error(`${t.id} is "${t.status}"; ${action} needs: ${allowed.join(' | ')}`);
};

export const actions = {
  run: (id) => updateTicket(normId(id), (t) => { guard(t, ['backlog', 'failed'], 'run'); t.status = 'ready'; t.error = ''; t.planOnly = false; event(t, 'queued'); }),
  // Write (or rewrite) the brief only, then park in backlog so a human can read/edit it before Run.
  plan: (id) => updateTicket(normId(id), (t) => {
    guard(t, ['backlog', 'failed'], 'plan');
    t.status = 'ready'; t.resume = 'plan'; t.mode = 'full'; t.planOnly = true; t.error = ''; event(t, 'plan only requested');
  }),
  stop: (id) => updateTicket(normId(id), (t) => { guard(t, ['running', 'ready'], 'stop'); if (t.status === 'ready') { t.status = 'backlog'; t.planOnly = false; } else t.cancel = true; event(t, 'stop requested'); }),
  approve: (id) => updateTicket(normId(id), (t) => { guard(t, ['review'], 'approve'); t.status = 'approved'; event(t, 'approved → push + PR'); }),
  changes: (id, text) => updateTicket(normId(id), (t) => {
    guard(t, ['review', 'pr_open'], 'changes');
    if (!text?.trim()) throw new Error('feedback text required');
    t.feedback.push(text.trim()); t.resume = 'code'; t.status = 'ready'; event(t, `changes requested: ${text.trim().slice(0, 80)}`);
  }),
  answer: (id, text) => updateTicket(normId(id), (t) => {
    guard(t, ['needs_info'], 'answer');
    if (!text?.trim()) throw new Error('answer text required');
    t.answers = [...(t.answers || []), `Questions:\n${readText(t.id, 'questions.md').trim()}\nAnswers:\n${text.trim()}`];
    t.resume = 'plan'; t.status = 'ready'; event(t, 'answered');
  }),
  reject: (id) => updateTicket(normId(id), (t) => { guard(t, ['backlog', 'ready', 'needs_info', 'review', 'failed', 'pr_open'], 'reject'); t.status = 'rejected'; t.planOnly = false; event(t, 'rejected'); }),
  // Undo a reject: back to backlog. If cleanup already removed the worktree, the next run branches fresh from the base.
  reopen: (id) => updateTicket(normId(id), (t) => {
    guard(t, ['rejected'], 'reopen');
    t.status = 'backlog'; t.error = ''; t.planOnly = false; t.cancel = false; t.picks = [];
    t.resume = readText(t.id, 'brief.md') ? 'code' : 'plan';
    if (!t.worktree) { t.baseSha = ''; t.setupDone = false; }
    event(t, 'reopened');
  }),
  done: (id) => updateTicket(normId(id), (t) => { guard(t, ['pr_open', 'review'], 'done'); t.status = 'done'; event(t, 'done'); }),
  // Bug lifecycle after the fix lands: the reporter confirms it (e2e runs also do this for bugs they filed)…
  verify: (id) => updateTicket(normId(id), (t) => { fixedBug(t, 'verify'); t.verifiedAt = new Date().toISOString(); t.verifiedBy = 'you'; event(t, 'verified: fix confirmed'); }),
  // …or it is still broken: its branch is merged, so a new bug ticket carries the report, screenshots and a link back.
  broken: (id, text) => {
    const t = getTicket(normId(id));
    fixedBug(t, 'broken');
    if (!text?.trim()) throw new Error('say what is still broken');
    const n = createWithImages({ repo: t.repo, kind: 'bug', severity: t.severity, source: t.source,
      title: `Still broken: ${t.title.replace(/^Still broken: /, '')}`.slice(0, 120),
      description: `${t.description}\n\n## Still broken after ${t.id}${t.pr ? ` (${t.pr})` : ''}\n${text.trim()}\nThe earlier fix is merged: find why it did not cover this case.` },
    listAttachments(t.id).map((f) => fromFile(attachmentPath(t.id, f))));
    return updateTicket(t.id, (x) => { x.verifiedAt = ''; x.reopenedAs = n.id; event(x, `still broken → ${n.id}`); });
  },
  get: (id) => getTicket(normId(id)),
};
