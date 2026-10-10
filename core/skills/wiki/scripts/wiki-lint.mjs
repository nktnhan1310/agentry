#!/usr/bin/env node
// Mechanical wiki checks so the model doesn't spend tokens reading every page.
// usage: node wiki-lint.mjs [wikiDir=.wiki] [--fix]
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULTS = { wikiIndexLines: 80, wikiPageLines: 200, wikiLogLines: 200 };

function pages(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'log-archive') out.push(...pages(p, base)); } else if (e.name.endsWith('.md')) out.push(relative(base, p).replaceAll('\\', '/'));
  }
  return out;
}

export function lintWiki(wiki, budgets = {}, { fix = false, repo = resolve(wiki, '..') } = {}) {
  const b = { ...DEFAULTS, ...budgets };
  const issues = [];
  if (!existsSync(join(wiki, 'index.md'))) return ['missing index.md'];
  const all = pages(wiki);
  const index = readFileSync(join(wiki, 'index.md'), 'utf8');
  const lines = (s) => s.trimEnd().split(/\r?\n/).length;

  if (lines(index) > b.wikiIndexLines) issues.push(`index.md ${lines(index)} > ${b.wikiIndexLines} lines: group pages into folders`);

  const logPath = join(wiki, 'log.md');
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, 'utf8').trimEnd().split(/\r?\n/);
    if (log.length > b.wikiLogLines) {
      if (fix) {
        const head = log.slice(0, 2);
        const keep = log.slice(-100);
        const old = log.slice(2, log.length - 100);
        const arch = join(wiki, 'log-archive', `${new Date().toISOString().slice(0, 10)}.md`);
        mkdirSync(dirname(arch), { recursive: true });
        writeFileSync(arch, old.join('\n') + '\n', { flag: 'a' });
        writeFileSync(logPath, [...head, ...keep].join('\n') + '\n');
      } else issues.push(`log.md ${log.length} > ${b.wikiLogLines} lines: run with --fix to archive`);
    }
  }

  for (const p of all) {
    const text = readFileSync(join(wiki, p), 'utf8');
    if (p !== 'log.md' && p !== 'index.md' && !p.startsWith('plans/') && lines(text) > b.wikiPageLines) issues.push(`${p} ${lines(text)} > ${b.wikiPageLines} lines: split it`);
    for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/i.test(target)) continue;
      if (!existsSync(resolve(wiki, dirname(p), target))) issues.push(`${p}: dead link → ${target}`);
    }
    for (const m of text.matchAll(/`([\w.@-]+(?:\/[\w.@-]+)+\.[a-z]{1,5})(?::\d+)?`/gi)) {
      const path = m[1];
      if (!existsSync(resolve(repo, path)) && !existsSync(resolve(wiki, dirname(p), path))) issues.push(`${p}: stale path \`${path}\``);
    }
  }

  const linked = new Set([...index.matchAll(/\]\(([^)#\s]+)/g)].map((m) => m[1].replace(/^\.\//, '')));
  const linkedDirs = [...linked].filter((l) => l.endsWith('/'));
  for (const p of all) {
    if (['index.md', 'log.md'].includes(p) || linked.has(p) || linkedDirs.some((d) => p.startsWith(d))) continue;
    issues.push(`${p}: not listed in index.md`);
  }
  return issues;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = resolve(args.find((a) => !a.startsWith('--')) || '.wiki');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) { console.error(`no wiki at ${dir}`); process.exit(1); }
  const issues = lintWiki(dir, {}, { fix: args.includes('--fix') });
  console.log(issues.length ? issues.map((i) => `✗ ${i}`).join('\n') : 'wiki: clean');
  process.exitCode = issues.length ? 1 : 0;
}
