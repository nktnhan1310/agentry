// PostToolUse(Write|Edit): keep CLAUDE.md / AGENTS.md within the line budget. Silent when fine.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const MAX = Number(process.env.KIT_ROOT_MD_MAX || 10);
let raw = '';
process.stdin.on('data', (d) => (raw += d)).on('end', () => {
  try {
    const file = JSON.parse(raw).tool_input?.file_path || '';
    if (!/^(CLAUDE|AGENTS)\.md$/i.test(basename(file))) return;
    const n = readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).length;
    if (n > MAX) {
      console.error(`${basename(file)} has ${n} lines (max ${MAX}). Move detail into a .wiki/ page, link it from .wiki/index.md, and cut this file back.`);
      process.exit(2);
    }
  } catch { /* never block on hook errors */ }
});
