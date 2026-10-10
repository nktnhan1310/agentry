#!/usr/bin/env node
// Runs a task brief through an external coding CLI and prints a compact summary.
// usage: node delegate.mjs <brief.md> [--engine opencode|codex] [--model m] [--timeout minutes]
import { execSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const brief = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!brief || !existsSync(brief)) {
  console.error('usage: node delegate.mjs <brief.md> [--engine opencode|codex] [--model m] [--timeout min]');
  process.exit(1);
}

let manifest = {};
try { manifest = JSON.parse(readFileSync('.kit/manifest.json', 'utf8')); } catch { /* defaults */ }
const engine = opt('engine', manifest.delegate?.engine || 'opencode');
const model = opt('model', manifest.delegate?.model || '');
const timeoutMin = Number(opt('timeout', manifest.delegate?.timeoutMin || 20));
const briefPath = resolve(brief).replaceAll('\\', '/');
const msg = `Execute the task brief in ${briefPath} exactly. Follow its Constraints. Run its Acceptance commands. Finish with the Report it asks for.`;

const q = (s) => `"${s.replaceAll('"', '\\"')}"`;
let cmd;
if (engine === 'opencode') {
  const agent = manifest.delegate?.opencodeAgent || 'kit-worker';
  cmd = `opencode run --agent ${agent} --auto --title ${q(`kit ${brief}`)}${model ? ` -m ${q(model)}` : ''} ${q(msg)}`;
} else if (engine === 'codex') {
  cmd = `codex exec --sandbox workspace-write${model ? ` -m ${q(model)}` : ''} ${q(msg)}`;
} else {
  console.error(`unknown engine: ${engine}`);
  process.exit(1);
}

const logPath = brief.replace(/\.md$/, '') + '.log';
const log = createWriteStream(logPath);
const tail = [];
const keep = (chunk) => {
  log.write(chunk);
  for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) tail.push(line);
  if (tail.length > 400) tail.splice(0, tail.length - 400);
};

const started = Date.now();
const child = spawn(cmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', keep);
child.stderr.on('data', keep);
const timer = setTimeout(() => { tail.push(`[delegate] timeout after ${timeoutMin} min, killing`); child.kill(); }, timeoutMin * 60_000);

child.on('close', (code) => {
  clearTimeout(timer);
  log.end();
  let stat = '';
  try {
    stat = execSync('git diff --stat', { encoding: 'utf8' }).trim();
    const added = execSync('git ls-files --others --exclude-standard', { encoding: 'utf8' })
      .split('\n').filter((f) => f && !/^\.(kit|claude|opencode|agents|wiki)\//.test(f));
    if (added.length) stat += `${stat ? '\n' : ''}new: ${added.slice(0, 20).join(', ')}${added.length > 20 ? ` (+${added.length - 20})` : ''}`;
  } catch { stat = '(not a git repo)'; }
  const secs = Math.round((Date.now() - started) / 1000);
  // Strip ANSI so the summary stays small and readable.
  const clean = tail.slice(-25).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  console.log(`engine: ${engine} · exit: ${code} · ${secs}s · log: ${logPath}`);
  console.log('--- worker (last lines) ---');
  console.log(clean.join('\n'));
  console.log('--- git diff --stat ---');
  console.log(stat || '(no changes)');
  process.exit(code ?? 1);
});
