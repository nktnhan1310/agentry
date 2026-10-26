// Telegram bot (long polling, no webhook, no deps). Only paired chat ids can use it.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { actions } from './actions.mjs';
import { kTok } from './engines.mjs';
import { formatAnswers, loadQuestions, optionLetter } from './questions.mjs';
import { createTicket, listTickets, loadConfig, loadState, readText, saveConfig, saveState, ticketFile, updateTicket } from './store.mjs';

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…` : s);
const ICON = { backlog: '📥', ready: '⏳', running: '⚙️', needs_info: '❓', review: '👀', approved: '🚀', pr_open: '🔗', failed: '💥', rejected: '🗑', done: '✅' };

export async function tg(method, body, token = loadConfig().telegram.token) {
  if (!token) return null;
  const isForm = body instanceof FormData;
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: isForm ? undefined : { 'content-type': 'application/json' },
    body: isForm ? body : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok && method !== 'getUpdates') console.error(`telegram ${method}: ${j.description || res.status}`);
  return j.result;
}

const btn = (text, data) => ({ text, callback_data: data });

const LABEL = { needs_info: 'needs info', review: 'ready for review', approved: 'pushing + opening PR', pr_open: 'PR open', done: 'done' };
const section = (md, name) => (md.match(new RegExp(`### ${name}\\n([\\s\\S]*?)(?=\\n### |$)`)) || [])[1]?.trim() || '';

// Finished-ticket report: plain-language part for everyone, then the engineer details.
function report(t) {
  const out = [];
  if (t.description) out.push(`<i>${esc(clip(t.description, 300))}</i>`);
  const notes = readText(t.id, 'notes.md');
  const summary = readText(t.id, 'summary.md');
  if (notes) {
    const part = (h) => (notes.match(new RegExp(`## ${h}\\n([\\s\\S]*?)(?=\\n## |$)`)) || [])[1]?.trim() || '';
    out.push('', '📋 <b>What changed — for everyone</b>', esc(clip(part('For everyone'), 700)), '', '🛠 <b>For engineers</b>', esc(clip(part('For engineers'), 1000)));
  } else if (summary) return [...out, '', `<pre>${esc(clip(summary.replace(/^## .*\n/, ''), 2500))}</pre>`];
  const checks = section(summary, 'Verify').split('\n').filter(Boolean).join(' · ');
  const files = section(summary, 'Changes').replace(/```/g, '').trim().split('\n').pop().trim();
  const verdict = (section(summary, 'Review').match(/VERDICT:\s*(\w+)/) || [])[1];
  out.push('');
  if (checks) out.push(`✅ Checks: ${esc(clip(checks, 300))}`);
  if (verdict) out.push(`🔎 Review: ${verdict === 'PASS' ? 'passed' : 'blocking issues left — see diff'}`);
  if (files) out.push(`📁 ${esc(files)}`);
  return out;
}

// One button per option ("✅ 1a · Hold T8…"), selection kept on the ticket (t.picks) until Send.
function questionRows(t) {
  const qs = loadQuestions(t.id);
  if (!qs) return [];
  const rows = qs.flatMap((x, i) => x.options.map((o, k) => {
    const on = (t.picks?.[i] ?? x.default) === k;
    return [btn(`${on ? '✅' : '▫️'} ${i + 1}${optionLetter(k)} · ${o}`.slice(0, 60), `pick:${t.id}:${i}:${k}`)];
  }));
  return [...rows, [btn('📨 Send these answers', `send:${t.id}`)]];
}

export function card(t) {
  const lines = [
    `${ICON[t.status] || ''} <b>${t.key ? `${esc(t.key)} · ` : ''}${t.id}</b> · ${esc(t.repo)} · <i>${LABEL[t.status] || t.status}${t.stage ? ` (${t.stage})` : ''}</i>`,
    `${t.kind === 'bug' ? `🐞 <i>${esc(t.severity || 'medium')}</i> ` : ''}<b>${esc(t.title)}</b>${t.verifiedAt ? ` · ✔ verified${t.verifiedBy === 'e2e' ? ' by e2e' : ''}` : ''}`,
  ];
  if (t.status === 'needs_info') lines.push('', esc(clip(readText(t.id, 'questions.md'), 2500)), ...(loadQuestions(t.id) ? ['', '👇 Tap your choice for each question (✅ = selected, suggested ones are pre-selected), then <b>Send</b>.'] : []));
  if (t.status === 'backlog' && readText(t.id, 'brief.md')) lines.push('', '📝 <b>Plan ready</b> — press Run to code it', `<pre>${esc(clip(readText(t.id, 'brief.md'), 2500))}</pre>`);
  if (['review', 'approved', 'pr_open', 'done'].includes(t.status)) lines.push(...report(t));
  if (t.status === 'review' && t.worktree) lines.push(`🧪 Test locally: <code>${esc(t.worktree)}</code>`);
  if (t.status === 'failed' && t.error) lines.push('', `<pre>${esc(clip(t.error, 1500))}</pre>`);
  if (t.pr) lines.push(`🔗 PR: ${esc(t.pr)}${t.autoMerge === 'pending' ? ' (auto-merge on)' : t.autoMerge === 'merged' ? ' (merged)' : ''}`);
  const tok = Object.values(t.tokens || {}).reduce((n, s) => n + s.in + s.out, 0);
  if (t.cost?.claudeUsd || tok) lines.push(`💰 Claude ≈ $${t.cost?.claudeUsd || 0}${tok ? ` · 🪙 ${kTok(tok)} tokens` : ''} · iterations ${t.iterations}`);

  const k = t.id;
  const rows = {
    backlog: [[btn('▶ Run', `run:${k}`), btn('📝 Plan only', `plan:${k}`), btn('🗑 Reject', `reject:${k}`)]],
    ready: [[btn('⏹ Stop', `stop:${k}`)]],
    running: [[btn('📜 Log', `log:${k}`), btn('⏹ Stop', `stop:${k}`)]],
    needs_info: [...questionRows(t), [btn('💬 Type answers', `answer:${k}`), btn('🗑 Reject', `reject:${k}`)]],
    review: [[btn('📄 Diff', `diff:${k}`), btn('✅ Approve → PR', `approve:${k}`)], [btn('🔁 Request changes', `changes:${k}`), btn('🗑 Reject', `reject:${k}`)]],
    failed: [[btn('🔁 Retry', `run:${k}`), btn('📜 Log', `log:${k}`), btn('🗑 Reject', `reject:${k}`)]],
    pr_open: [[...(t.pr ? [{ text: '🔗 Open PR', url: t.pr }] : []), btn('🔁 Changes', `changes:${k}`), btn('✔ Done', `done:${k}`)]],
    rejected: [[btn('♻️ Reopen', `reopen:${k}`)]],
    done: t.kind === 'bug' && !t.verifiedAt ? [[btn('✔ Verified', `verify:${k}`), btn('🐞 Still broken', `broken:${k}`)]] : [],
  }[t.status] || [];
  return { text: clip(lines.join('\n'), 4000), reply_markup: { inline_keyboard: rows } };
}

export async function broadcast(payload) {
  const cfg = loadConfig();
  for (const chat_id of cfg.telegram.allowedChatIds) await tg('sendMessage', { chat_id, parse_mode: 'HTML', disable_web_page_preview: true, ...payload });
}

const HELP = `<b>agentry hub</b>
/new &lt;repo&gt; &lt;title&gt; — queued: Claude plans → opencode codes → Claude reviews (next lines = description)
/quick &lt;repo&gt; &lt;title&gt; — small change: opencode only, no Claude plan (cheapest)
/draft &lt;repo&gt; &lt;title&gt; — new ticket in backlog
/list [status|repo] — active tickets
/t &lt;id&gt; — ticket card · /repos · /status
/answer &lt;id&gt; &lt;text&gt; · /changes &lt;id&gt; &lt;text&gt;
/pause · /resume — pause/resume the loop`;

function latestLog(id) {
  const dir = ticketFile(id, 'logs');
  if (!existsSync(dir)) return '';
  const f = readdirSync(dir).map((n) => join(dir, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  return f ? readFileSync(f, 'utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).filter(Boolean).slice(-40).join('\n') : '';
}

async function sendDiff(chat_id, id) {
  const patch = readText(id, 'diff.patch');
  if (!patch) return tg('sendMessage', { chat_id, text: 'no diff yet' });
  if (patch.length < 3000) return tg('sendMessage', { chat_id, parse_mode: 'HTML', text: `<pre><code class="language-diff">${esc(patch)}</code></pre>` });
  const fd = new FormData();
  fd.append('chat_id', String(chat_id));
  fd.append('caption', `${id} diff`);
  fd.append('document', new Blob([patch], { type: 'text/plain' }), `${id}.diff.txt`);
  return tg('sendDocument', fd);
}

async function ask(chat_id, id, kind) {
  const prompt = kind === 'answer' ? `Reply to this message with answers for ${id}` : kind === 'broken' ? `Reply with what is still broken in ${id} (a new bug ticket is opened)` : `Reply to this message with the changes you want for ${id}`;
  const m = await tg('sendMessage', { chat_id, text: prompt, reply_markup: { force_reply: true, input_field_placeholder: kind === 'answer' ? 'Answers…' : kind === 'broken' ? 'What still happens…' : 'What should change…' } });
  if (m) { const s = loadState(); s.prompts = { ...(s.prompts || {}), [m.message_id]: { id, kind } }; saveState(s); }
}

export function parseNew(text, cfg) {
  const [first, ...rest] = text.split('\n');
  const words = first.replace(/^\/(new|draft|quick)(@\w+)?\s*/, '').trim().split(/\s+/);
  const repos = Object.keys(cfg.repos);
  let repo = repos.find((r) => r.toLowerCase() === (words[0] || '').toLowerCase());
  if (repo) words.shift();
  else if (repos.length === 1) repo = repos[0];
  else throw new Error(`which repo? ${repos.join(', ')}`);
  const title = words.join(' ').trim();
  if (!title) throw new Error('usage: /new <repo> <title>\\n<description>');
  return { repo, title, description: rest.join('\n').trim() };
}

async function onMessage(m) {
  const chat_id = m.chat.id;
  const text = (m.text || '').trim();
  const cfg = loadConfig();
  const reply = (t) => tg('sendMessage', { chat_id, parse_mode: 'HTML', text: t });

  if (!cfg.telegram.allowedChatIds.includes(chat_id)) {
    const code = text.match(/^\/pair\s+(\S+)/)?.[1];
    if (code && cfg.telegram.pairCode && code === cfg.telegram.pairCode) {
      cfg.telegram.allowedChatIds.push(chat_id);
      cfg.telegram.pairCode = '';
      saveConfig(cfg);
      return reply(`Paired ✅\n${HELP}`);
    }
    return; // ignore strangers silently
  }

  const pending = m.reply_to_message && loadState().prompts?.[m.reply_to_message.message_id];
  if (pending) {
    const s = loadState(); delete s.prompts[m.reply_to_message.message_id]; saveState(s);
    const t = actions[pending.kind](pending.id, text);
    return tg('sendMessage', { chat_id, parse_mode: 'HTML', ...card(t) });
  }

  const [cmd, ...args] = text.split(/\s+/);
  switch (cmd.replace(/@\w+$/, '')) {
    case '/start': case '/help': return reply(HELP);
    case '/repos': return reply(Object.entries(cfg.repos).map(([n, r]) => `• <b>${esc(n)}</b> — ${esc(r.path)} (${esc(r.base || 'main')})`).join('\n') || 'no repos; add with `kit hub repo add <path>` on the PC');
    case '/new': case '/draft': case '/quick': {
      const t = createTicket({ ...parseNew(text, cfg), status: cmd.startsWith('/draft') ? 'backlog' : 'ready', mode: cmd.startsWith('/quick') ? 'quick' : 'full' });
      return tg('sendMessage', { chat_id, parse_mode: 'HTML', ...card(t) });
    }
    case '/list': {
      const f = args[0];
      const all = listTickets().filter((t) => (f ? t.status === f || t.repo === f : !['done', 'rejected'].includes(t.status)));
      if (!all.length) return reply('nothing here');
      const rows = all.slice(-20).map((t) => [btn(`${ICON[t.status]} ${t.id} · ${t.title}`.slice(0, 60), `show:${t.id}`)]);
      return tg('sendMessage', { chat_id, text: `${all.length} ticket(s)`, reply_markup: { inline_keyboard: rows } });
    }
    case '/t': return tg('sendMessage', { chat_id, parse_mode: 'HTML', ...card(actions.get(args[0])) });
    case '/answer': case '/changes': {
      const t = actions[cmd.slice(1)](args[0], args.slice(1).join(' '));
      return tg('sendMessage', { chat_id, parse_mode: 'HTML', ...card(t) });
    }
    case '/pause': case '/resume': { const s = loadState(); s.paused = cmd === '/pause'; saveState(s); return reply(s.paused ? '⏸ loop paused (running tickets finish)' : '▶ loop resumed'); }
    case '/status': {
      const s = loadState();
      const count = (st) => listTickets({ status: st }).length;
      return reply(`${s.paused ? '⏸ paused' : '▶ running'} · ⚙️ ${count('running')} · ⏳ ${count('ready')} · 👀 ${count('review')} · ❓ ${count('needs_info')} · 💥 ${count('failed')}`);
    }
    default: return reply(`unknown command\n${HELP}`);
  }
}

async function onCallback(q) {
  const chat_id = q.message.chat.id;
  const cfg = loadConfig();
  if (!cfg.telegram.allowedChatIds.includes(chat_id)) return;
  const [act, id, qi, oi] = q.data.split(':');
  let note = '';
  const redraw = (t) => tg('editMessageReplyMarkup', { chat_id, message_id: q.message.message_id, reply_markup: card(t).reply_markup });
  try {
    if (act === 'pick') {
      const t = updateTicket(id, (x) => { if (x.status !== 'needs_info') throw new Error(`${x.id} is "${x.status}" now`); x.picks = x.picks || []; x.picks[Number(qi)] = Number(oi); });
      note = `Q${Number(qi) + 1}: ${optionLetter(Number(oi))}`;
      await redraw(t);
    } else if (act === 'send') {
      const qs = loadQuestions(id) || [];
      const t = actions.answer(id, formatAnswers(qs, actions.get(id).picks || []));
      note = `${id}: answers sent, re-planning`;
      await redraw(t);
    } else if (act === 'show') await tg('sendMessage', { chat_id, parse_mode: 'HTML', ...card(actions.get(id)) });
    else if (act === 'diff') await sendDiff(chat_id, id);
    else if (act === 'log') await tg('sendMessage', { chat_id, parse_mode: 'HTML', text: `<pre>${esc(clip(latestLog(id) || 'no logs', 3500))}</pre>` });
    else if (act === 'answer' || act === 'changes' || act === 'broken') await ask(chat_id, id, act);
    else {
      const t = actions[act](id);
      note = `${id}: ${t.status}`;
      await tg('editMessageReplyMarkup', { chat_id, message_id: q.message.message_id, reply_markup: card(t).reply_markup });
    }
  } catch (e) { note = e.message.slice(0, 190); }
  await tg('answerCallbackQuery', { callback_query_id: q.id, text: note });
}

export async function startBot(log = console.log) {
  let offset = loadState().tgOffset || 0;
  log('telegram: polling');
  for (;;) {
    const token = loadConfig().telegram.token;
    if (!token) { await new Promise((r) => setTimeout(r, 10_000)); continue; }
    try {
      const updates = (await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }, token)) || [];
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          if (u.message) await onMessage(u.message);
          else if (u.callback_query) await onCallback(u.callback_query);
        } catch (e) {
          const chat_id = u.message?.chat.id || u.callback_query?.message.chat.id;
          if (chat_id && loadConfig().telegram.allowedChatIds.includes(chat_id)) await tg('sendMessage', { chat_id, text: `⚠️ ${e.message}` });
        }
      }
      if (updates.length) { const s = loadState(); s.tgOffset = offset; saveState(s); }
    } catch (e) {
      log(`telegram error: ${e.message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
