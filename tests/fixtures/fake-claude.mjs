// Test double for `claude -p` (KIT_CLAUDE_BIN): records cwd/args/prompt, answers by prompt kind,
// appends a line to feature.txt in the worktree on code turns. Test verdicts come from FAKE_VERDICTS.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const prompt = readFileSync(0, 'utf8');
const kind = /You are planning/.test(prompt) ? 'plan' : /Execute the task brief/.test(prompt) ? 'code'
  : /^Review the changes|\nReview the changes/.test(prompt) ? 'review' : /Test the change/.test(prompt) ? 'test' : 'other';
appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ kind, cwd: process.cwd(), args, prompt })}\n`);

let result = '';
if (kind === 'plan') result = '# Task: add the feature\nGoal: one line in feature.txt';
if (kind === 'code') {
  const at = args.indexOf('--add-dir');
  const f = join(at >= 0 ? args[at + 1] : process.cwd(), 'feature.txt');
  writeFileSync(f, `${existsSync(f) ? readFileSync(f, 'utf8') : ''}line\n`);
  result = 'changed feature.txt';
}
if (kind === 'review') result = 'VERDICT: PASS';
if (kind === 'test') {
  const q = existsSync(process.env.FAKE_VERDICTS) ? readFileSync(process.env.FAKE_VERDICTS, 'utf8').split('\n').filter(Boolean) : [];
  const v = q.shift() || 'PASS';
  writeFileSync(process.env.FAKE_VERDICTS, q.join('\n'));
  result = `VERDICT: ${v}\nnpm test: ${v === 'PASS' ? '3 passed' : '1 failed'}${v === 'FAIL' ? '\n`adds a line` — expected 2 lines' : ''}`;
}
process.stdout.write(`${JSON.stringify({ type: 'result', result, total_cost_usd: 0.001, is_error: false })}\n`);
