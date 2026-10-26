// Planner questions as choices: [{ q, options[], default }] so the UI and Telegram can offer one-tap answers.
import { readText } from './store.mjs';

const L = 'abcdef';

export function parseQuestions(text) {
  const i = text.indexOf('['), j = text.lastIndexOf(']');
  if (i < 0 || j < i) return null;
  try {
    const qs = JSON.parse(text.slice(i, j + 1))
      .filter((x) => x?.q && Array.isArray(x.options) && x.options.length)
      .slice(0, 5)
      .map((x) => {
        const options = x.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 5);
        return { q: String(x.q).trim(), options, default: Number.isInteger(x.default) && x.default >= 0 && x.default < options.length ? x.default : 0 };
      });
    return qs.length ? qs : null;
  } catch { return null; }
}

export const renderQuestions = (qs) => qs.map((x, i) => `${i + 1}. ${x.q}\n${x.options.map((o, k) => `   ${L[k]}) ${o}${k === x.default ? '  (suggested)' : ''}`).join('\n')}`).join('\n\n');

// picks[i]: chosen option index, or a string with the human's own answer; missing = the suggested default.
export const formatAnswers = (qs, picks = [], note = '') => qs.map((x, i) => {
  const p = picks[i] ?? x.default;
  return `${i + 1}. ${x.q}\n→ ${typeof p === 'string' ? p : x.options[p]}`;
}).join('\n') + (note.trim() ? `\nAlso: ${note.trim()}` : '');

export function loadQuestions(id) {
  try { return parseQuestions(readText(id, 'questions.json')); } catch { return null; }
}

export const optionLetter = (k) => L[k];
