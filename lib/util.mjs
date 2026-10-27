import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
export const lf = (s) => s.replace(/\r\n/g, '\n');
export const read = (p) => lf(readFileSync(p, 'utf8'));
export const toPosix = (p) => p.split(sep).join('/');

export function readJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
}

export function write(p, content) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// Recursive file list relative to root (posix separators).
export function walk(root, { maxDepth = Infinity, ignore = [] } = {}) {
  const out = [];
  const visit = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!ignore.includes(e.name) && depth < maxDepth) visit(full, depth + 1);
      } else out.push(toPosix(relative(root, full)));
    }
  };
  if (isDir(root)) visit(root, 0);
  return out;
}

// Remove empty parent dirs up to (not including) stop.
export function pruneDirs(p, stop) {
  let d = dirname(p);
  while (d.startsWith(stop) && d !== stop) {
    try { if (readdirSync(d).length) return; rmdirSync(d); } catch { return; }
    d = dirname(d);
  }
}

export function globToRe(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?');
  return new RegExp(`^${re}$`, 'i');
}

export function deepMerge(a, b) {
  if (Array.isArray(b) || typeof b !== 'object' || b === null) return b === undefined ? a : b;
  const r = { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) r[k] = deepMerge(r[k], v);
  return r;
}

// Minimal frontmatter: `key: value` and `key: [a, b]` only.
export function parseFm(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    else if (v === 'true' || v === 'false') v = v === 'true';
    else v = v.replace(/^(["'])(.*)\1$/, '$2');
    data[kv[1]] = v;
  }
  return { data, body: text.slice(m[0].length) };
}

const yamlScalar = (v) => (typeof v === 'string' && /[:#[\]{}&*!|>'"%@`,]|^\s|\s$/.test(v) ? JSON.stringify(v) : String(v));

export function fm(data) {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== '' && v !== null)
    .map(([k, v]) => `${k}: ${yamlScalar(v)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

export const lineCount = (s) => (s.trimEnd() ? s.trimEnd().split('\n').length : 0);

export function onPath(bin) {
  try { execSync(process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; }
}
