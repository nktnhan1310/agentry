// Repo-configured shell commands (cleanup, evidence, publish, notify) with {placeholder} expansion.
import { shell } from './engines.mjs';
import { fill, KEY_RE, ticketDir, ticketKey } from './store.mjs';

// Placeholder values for one ticket. The key is checked again here: it may come from an import.
export function vars(t, repo = {}) {
  const ticket = ticketKey(t);
  if (!KEY_RE.test(ticket)) throw new Error(`unsafe ticket key "${ticket}"`);
  return { ticket, id: t.id, repo: t.repo, worktree: t.worktree || '', branch: t.branch || '', base: repo.base || 'main', dir: ticketDir(t.id).replaceAll('\\', '/') };
}

// Values also reach the command as KIT_TICKET, KIT_WORKTREE, … so scripts need no argument parsing.
export const envOf = (v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [`KIT_${k.toUpperCase()}`, String(x)]));

export const runCommand = (tpl, v, opts = {}) => shell(fill(tpl, v), { ...opts, env: { ...opts.env, ...envOf(v) } });

// A publish command reports what it created with `pr=<url>` / `comment=<url>` lines.
export const outputs = (text) => Object.fromEntries([...text.matchAll(/^(pr|comment)=(\S+)\s*$/gm)].map((m) => [m[1], m[2]]));

// First `VERDICT:` (or `OVERALL:`) line of a test report; no verdict counts as BLOCKED.
export const verdict = (text) => (String(text).match(/^\s*(?:VERDICT|OVERALL):\s*(PASS|FAIL|BLOCKED)\b/m) || [])[1] || 'BLOCKED';
