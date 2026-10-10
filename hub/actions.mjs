// Human actions on tickets. CLI and Telegram only change state; the daemon does the work.
import { event, getTicket, normId, readText, updateTicket } from './store.mjs';

const guard = (t, allowed, action) => {
  if (!allowed.includes(t.status)) throw new Error(`${t.id} is "${t.status}"; ${action} needs: ${allowed.join(' | ')}`);
};

export const actions = {
  run: (id) => updateTicket(normId(id), (t) => { guard(t, ['backlog', 'failed'], 'run'); t.status = 'ready'; t.error = ''; event(t, 'queued'); }),
  stop: (id) => updateTicket(normId(id), (t) => { guard(t, ['running', 'ready'], 'stop'); if (t.status === 'ready') t.status = 'backlog'; else t.cancel = true; event(t, 'stop requested'); }),
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
  reject: (id) => updateTicket(normId(id), (t) => { guard(t, ['backlog', 'ready', 'needs_info', 'review', 'failed', 'pr_open'], 'reject'); t.status = 'rejected'; event(t, 'rejected'); }),
  done: (id) => updateTicket(normId(id), (t) => { guard(t, ['pr_open', 'review'], 'done'); t.status = 'done'; event(t, 'done'); }),
  get: (id) => getTicket(normId(id)),
};
