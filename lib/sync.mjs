import { existsSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as claude from '../adapters/claude.mjs';
import * as codex from '../adapters/codex.mjs';
import * as opencode from '../adapters/opencode.mjs';
import { detectCommands, detectPacks, scan } from './detect.mjs';
import { overhead } from './overhead.mjs';
import { loadSources } from './sources.mjs';
import { deepMerge, KIT, lineCount, pruneDirs, read, readJson, sha, walk, write } from './util.mjs';

const ADAPTERS = { claude, opencode, codex };
const MANIFEST = '.kit/manifest.json';

export function loadConfig(repo) {
  const base = readJson(join(KIT, 'kit.config.json'));
  return deepMerge(base, repo ? readJson(join(repo, '.kit', 'config.json'), {}) : {});
}

function mergeSettings(cur = {}, kit) {
  const r = structuredClone(cur);
  r.permissions ??= {};
  for (const k of ['allow', 'deny']) {
    const all = [...(r.permissions[k] || []), ...(kit.permissions?.[k] || [])];
    if (all.length) r.permissions[k] = [...new Set(all)];
  }
  r.hooks ??= {};
  for (const [ev, groups] of Object.entries(kit.hooks || {})) {
    r.hooks[ev] ??= [];
    for (const g of groups) {
      for (const h of g.hooks) {
        if (r.hooks[ev].some((x) => x.hooks?.some((y) => y.command === h.command))) continue;
        let tgt = r.hooks[ev].find((x) => x.matcher === g.matcher);
        if (!tgt) r.hooks[ev].push((tgt = { matcher: g.matcher, hooks: [] }));
        tgt.hooks.push(h);
      }
    }
  }
  return r;
}

function seeds(repo, info, packs) {
  const cmds = detectCommands(repo, info);
  const fmt = (a) => (a.length ? a.map((c) => `\`${c}\``).join(' · ') : 'TODO');
  const vars = {
    name: basename(resolve(repo)),
    stack: packs.length ? packs.join(', ') : 'TODO',
    build: fmt(cmds.build),
    test: fmt(cmds.test),
    lint: fmt(cmds.lint),
  };
  const dir = join(KIT, 'core', 'templates');
  return walk(dir).map((rel) => ({
    path: rel.replace(/^wiki\//, '.wiki/').replace(/\.gitkeep\.tpl$/, '.gitkeep'),
    content: read(join(dir, rel)).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? ''),
  }));
}

export function sync(repoArg, opts = {}) {
  const repo = resolve(repoArg || '.');
  const cfg = loadConfig(repo);
  if (opts.tools) cfg.tools = opts.tools.split(',');
  const info = scan(repo, cfg);
  const packs = opts.packs ? opts.packs.split(',') : detectPacks(repo, cfg, info);
  const src = loadSources(repo, packs);
  const old = readJson(join(repo, MANIFEST), { files: {} });

  const outputs = new Map();
  const merges = new Map();
  const ctx = { cfg, emit: (p, c) => outputs.set(p, c), merge: (p, obj) => merges.set(p, obj) };
  for (const t of cfg.tools) {
    if (!ADAPTERS[t]) throw new Error(`unknown tool "${t}" (claude|opencode|codex)`);
    ADAPTERS[t].render(src, ctx);
  }

  const res = { added: [], updated: [], same: [], skipped: [], removed: [], kept: [], seeded: [], notes: [] };
  const files = {};
  const doWrite = (p, c) => !opts.dry && write(join(repo, p), c);

  for (const [p, content] of outputs) {
    const full = join(repo, p);
    const h = sha(content);
    if (!existsSync(full)) { doWrite(p, content); res.added.push(p); files[p] = h; continue; }
    const curH = sha(read(full));
    if (curH === h) { res.same.push(p); files[p] = h; continue; }
    if ((old.files[p] && curH === old.files[p]) || opts.force) { doWrite(p, content); res.updated.push(p); files[p] = h; continue; }
    res.skipped.push(p);
    if (old.files[p]) files[p] = old.files[p];
  }

  for (const [p, h] of Object.entries(old.files)) {
    if (outputs.has(p)) continue;
    const full = join(repo, p);
    if (!existsSync(full)) continue;
    if (sha(read(full)) === h) {
      if (!opts.dry) { rmSync(full); pruneDirs(full, repo); }
      res.removed.push(p);
    } else res.kept.push(p);
  }

  for (const [p, obj] of merges) {
    const full = join(repo, p);
    const cur = readJson(full, {});
    const next = JSON.stringify(mergeSettings(cur, obj), null, 2) + '\n';
    if (!existsSync(full)) { doWrite(p, next); res.added.push(p); }
    else if (JSON.stringify(cur, null, 2) + '\n' !== next) { doWrite(p, next); res.updated.push(`${p} (merged)`); }
  }

  for (const s of seeds(repo, info, packs)) {
    if (existsSync(join(repo, s.path))) continue;
    doWrite(s.path, s.content);
    res.seeded.push(s.path);
  }

  const gi = join(repo, '.gitignore');
  const giText = existsSync(gi) ? read(gi) : '';
  if (!/^\.kit\/handoff\/?$/m.test(giText)) {
    doWrite('.gitignore', `${giText}${giText && !giText.endsWith('\n') ? '\n' : ''}.kit/handoff/\n`);
    res.notes.push('.gitignore += .kit/handoff/');
  }

  const max = cfg.budgets.rootMdLines;
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const full = join(repo, f);
    if (!existsSync(full) || res.seeded.includes(f)) continue;
    const n = lineCount(read(full));
    if (n > max) res.notes.push(`${f}: ${n} lines > ${max} → run "/wiki slim" to move detail into .wiki/`);
  }
  if (existsSync(join(repo, 'CLAUDE.md')) && !/^@AGENTS\.md/m.test(read(join(repo, 'CLAUDE.md'))) && !res.seeded.includes('CLAUDE.md')) {
    res.notes.push('CLAUDE.md does not import @AGENTS.md (OpenCode/Codex read AGENTS.md only)');
  }
  if (cfg.tools.includes('codex') && cfg.tools.includes('opencode')) {
    res.notes.push('codex+opencode: set OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 to avoid duplicate skills in OpenCode');
  }

  if (!opts.dry) {
    const manifest = { kit: cfg.version, syncedAt: new Date().toISOString(), tools: cfg.tools, packs, delegate: cfg.delegate, files };
    write(join(repo, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  }
  res.overhead = opts.dry ? null : overhead(repo);
  return { repo, cfg, packs, res };
}

export function report({ repo, cfg, packs, res }, dry) {
  const L = [];
  L.push(`agentry ${cfg.version}${dry ? ' (dry run)' : ''} → ${repo}`);
  L.push(`  tools: ${cfg.tools.join(', ')} · packs: ${packs.join(', ') || 'none'}`);
  L.push(`  +${res.added.length} new  ~${res.updated.length} updated  =${res.same.length} unchanged  -${res.removed.length} removed`);
  if (res.seeded.length) L.push(`  seeded: ${res.seeded.join(', ')}`);
  if (res.skipped.length) L.push(`  ! modified locally, skipped (use --force or move to .kit/local/): ${res.skipped.join(', ')}`);
  if (res.kept.length) L.push(`  ! no longer in kit but modified, kept: ${res.kept.join(', ')}`);
  for (const n of res.notes) L.push(`  • ${n}`);
  if (res.overhead) L.push(`  always-loaded context ≈ ${res.overhead.tokens} tokens (${res.overhead.items} descriptions + root md)`);
  return L.join('\n');
}
