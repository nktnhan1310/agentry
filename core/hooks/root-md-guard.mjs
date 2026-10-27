// PostToolUse(Write|Edit): keep CLAUDE.md / AGENTS.md within the line budget. Silent when fine.
// Mode and limit come from .kit/manifest.json (`rootMd`, written by `kit sync`): block | warn | off.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

let conf = {};
try { conf = JSON.parse(readFileSync(join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.kit', 'manifest.json'), 'utf8')).rootMd || {}; } catch { /* defaults */ }
const MAX = Number(process.env.KIT_ROOT_MD_MAX || conf.max || 10);
const MODE = conf.mode || 'block';
let raw = '';
process.stdin.on('data', (d) => (raw += d)).on('end', () => {
  try {
    const file = JSON.parse(raw).tool_input?.file_path || '';
    if (MODE === 'off' || !/^(CLAUDE|AGENTS)\.md$/i.test(basename(file))) return;
    const n = readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).length;
    if (n <= MAX) return;
    const msg = `${basename(file)} has ${n} lines (max ${MAX}). Move detail into a .wiki/ page, link it from .wiki/index.md, and cut this file back.`;
    if (MODE === 'warn') return console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg } }));
    console.error(msg);
    process.exit(2);
  } catch { /* never block on hook errors */ }
});
