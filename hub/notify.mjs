// Phone notifications: Telegram card (with action buttons) + optional one-line ntfy push (never code).
import { loadConfig } from './store.mjs';
import { broadcast, card } from './telegram.mjs';

const LINE = {
  review: (t) => `${t.id} ready for review: ${t.title}`,
  needs_info: (t) => `${t.id} needs info: ${t.title}`,
  failed: (t) => `${t.id} failed: ${t.title}`,
  pr_open: (t) => `${t.id} PR opened: ${t.title}`,
  approve_failed: (t) => `${t.id} push/PR failed: ${t.title}`,
};

export async function notify(t, kind) {
  const cfg = loadConfig();
  try { await broadcast(card(t)); } catch (e) { console.error(`notify telegram: ${e.message}`); }
  const line = LINE[kind]?.(t);
  if (cfg.ntfy.topic && line) {
    try {
      await fetch(`${cfg.ntfy.server.replace(/\/$/, '')}/${cfg.ntfy.topic}`, {
        method: 'POST', body: line,
        headers: { Title: 'agentry', Tags: kind === 'review' ? 'eyes' : kind === 'pr_open' ? 'rocket' : 'warning' },
      });
    } catch (e) { console.error(`notify ntfy: ${e.message}`); }
  }
}
