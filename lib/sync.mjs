import { existsSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as claude from '../adapters/claude.mjs';
import * as codex from '../adapters/codex.mjs';
import * as opencode from '../adapters/opencode.mjs';
import { detectCommands, detectPacks, scan } from './detect.mjs';
import { excludeTarget, setExcludeBlock, trackedPaths } from './footprint.mjs';
import { overhead } from './overhead.mjs';
import { select, wants } from './select.mjs';
import { applySettings, removeSettings } from './settings.mjs';
import { loadSources } from './sources.mjs';
import { deepMerge, KIT, lineCount, pruneDirs, read, readJson, sha, walk, write } from './util.mjs';

const ADAPTERS = { claude, opencode, codex };
export const MANIFEST = '.kit/manifest.json';
export const rootMdMode = (cfg) => cfg.rootMd?.mode || 'block';
export const memoryDir = (cfg) => cfg.memory?.dir || '.wiki';
export const settingsFile = (cfg) => (cfg.footprint === 'untracked' ? '.claude/settings.local.json' : '.claude/settings.json');
const json = (o) => JSON.stringify(o, null, 2) + '\n';

export function loadConfig(repo) {
  const base = readJson(join(KIT, 'kit.config.json'));
  const cfg = deepMerge(base, repo ? readJson(join(repo, '.kit', 'config.json'), {}) : {});
  if (!['tracked', 'untracked'].includes(cfg.footprint || 'tracked')) throw new Error(`footprint "${cfg.footprint}": use tracked|untracked`);
  if (!['block', 'warn', 'off'].includes(rootMdMode(cfg))) throw new Error(`rootMd.mode "${cfg.rootMd.mode}": use block|warn|off`);
  if (!['opencode', 'codex', 'none'].includes(cfg.delegate?.engine || 'opencode')) throw new Error(`delegate.engine "${cfg.delegate.engine}": use opencode|codex|none`);
  if (cfg.namespace && !/^[a-z][a-z0-9]*$/.test(cfg.namespace)) throw new Error(`namespace "${cfg.namespace}": lowercase letters/digits only`);
  return cfg;
}

function seeds(repo, info, packs, cfg, rewrite) {
  const cmds = detectCommands(repo, info);
  const fmt = (a) => (a.length ? a.map((c) => `\`${c}\``).join(' · ') : 'TODO');
  const vars = { name: basename(resolve(repo)), stack: packs.length ? packs.join(', ') : 'TODO', build: fmt(cmds.build), test: fmt(cmds.test), lint: fmt(cmds.lint) };
  const dir = join(KIT, 'core', 'templates');
  const kind = (rel) => (rel.startsWith('wiki/') ? 'memory' : rel);
  return walk(dir).filter((rel) => wants(cfg.install?.templates, kind(rel))).map((rel) => ({
    path: rel.replace(/^wiki\//, `${memoryDir(cfg)}/`).replace(/\.gitkeep\.tpl$/, '.gitkeep'),
    content: rewrite(read(join(dir, rel)).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? ''), true),
  }));
}

export function sync(repoArg, opts = {}) {
  const repo = resolve(repoArg || '.');
  const cfg = loadConfig(repo);
  if (opts.tools) cfg.tools = opts.tools.split(',');
  const info = scan(repo, cfg);
  const packs = opts.packs ? opts.packs.split(',') : detectPacks(repo, cfg, info);
  const sel = select(loadSources(repo, packs), cfg);
  const old = readJson(join(repo, MANIFEST), { files: {} });
  const untracked = cfg.footprint === 'untracked';
  const dry = !!opts.dry;

  const outputs = new Map();
  const merges = new Map();
  const ctx = { cfg, settingsFile: settingsFile(cfg), emit: (p, c) => outputs.set(p, c), merge: (p, obj) => merges.set(p, obj) };
  for (const t of cfg.tools) {
    if (!ADAPTERS[t]) throw new Error(`unknown tool "${t}" (claude|opencode|codex)`);
    ADAPTERS[t].render(sel.src, ctx);
  }

  const res = { added: [], updated: [], same: [], skipped: [], foreign: [], removed: [], kept: [], seeded: [], settings: [], notes: [...sel.notes] };
  const files = {};
  const doWrite = (p, c) => !dry && write(join(repo, p), c);

  for (const [p, content] of outputs) {
    const full = join(repo, p);
    const h = sha(content);
    if (!existsSync(full)) { doWrite(p, content); res.added.push(p); files[p] = h; continue; }
    const curH = sha(read(full));
    if (curH === h) { res.same.push(p); files[p] = h; continue; }
    if (!old.files[p]) { res.foreign.push(p); continue; } // the project's own file: never overwritten, not even with --force
    if (curH === old.files[p] || opts.force) { doWrite(p, content); res.updated.push(p); files[p] = h; continue; }
    res.skipped.push(p);
    files[p] = old.files[p];
  }

  for (const [p, h] of Object.entries(old.files)) {
    if (outputs.has(p)) continue;
    const full = join(repo, p);
    if (!existsSync(full)) continue;
    if (sha(read(full)) === h) {
      if (!dry) { rmSync(full); pruneDirs(full, repo); }
      res.removed.push(p);
    } else res.kept.push(p);
  }

  // Settings: take back what a previous sync added to another file (footprint switched), then merge.
  let settings = old.settings;
  if (old.settings && !merges.has(old.settings.file) && existsSync(join(repo, old.settings.file))) {
    const { next, changes } = removeSettings(readJson(join(repo, old.settings.file), {}), old.settings.owned);
    if (changes.length) { doWrite(old.settings.file, json(next)); res.settings.push(...changes.map((c) => `${old.settings.file}: ${c}`)); }
    settings = undefined;
  }
  for (const [p, obj] of merges) {
    const full = join(repo, p);
    const existed = existsSync(full);
    const cur = readJson(full, {});
    const prev = settings?.file === p ? settings.owned : undefined;
    const { next, owned, changes } = applySettings(cur, obj, prev);
    if (!existed || json(cur) !== json(next)) { doWrite(p, json(next)); (existed ? res.updated : res.added).push(existed ? `${p} (merged)` : p); }
    res.settings.push(...changes.map((c) => `${p}: ${c}`));
    settings = { file: p, owned, created: settings?.file === p ? settings.created : !existed };
  }

  for (const s of seeds(repo, info, packs, cfg, sel.rewrite)) {
    if (existsSync(join(repo, s.path))) continue;
    doWrite(s.path, s.content);
    res.seeded.push(s.path);
  }
  const mem = memoryDir(cfg);
  const seeded = [...new Set([...(old.seeds || []), ...res.seeded.map((p) => (p.startsWith(`${mem}/`) ? `${mem}/` : p))])]
    .filter((p) => dry || existsSync(join(repo, p)));

  const target = excludeTarget(repo);
  if (untracked) {
    if (!target) res.notes.push('not a git repo: footprint "untracked" cannot hide kit files');
    const tracked = trackedPaths(repo, Object.keys(files));
    if (tracked.size) res.notes.push(`tracked by git, so excluding them has no effect (commit their removal or use footprint "tracked"): ${[...tracked].join(', ')}`);
    if (setExcludeBlock(target, ['.kit/', ...Object.keys(files), ...seeded, ...(settings ? [settings.file] : [])], { dry })) res.notes.push('.git/info/exclude: agentry block updated');
  } else {
    if (setExcludeBlock(target, [], { dry })) res.notes.push('.git/info/exclude: agentry block removed (footprint "tracked")');
    const gi = join(repo, '.gitignore');
    const giText = existsSync(gi) ? read(gi) : '';
    if (!/^\.kit\/handoff\/?$/m.test(giText)) {
      doWrite('.gitignore', `${giText}${giText && !giText.endsWith('\n') ? '\n' : ''}.kit/handoff/\n`);
      res.notes.push('.gitignore += .kit/handoff/');
    }
  }

  const max = cfg.budgets.rootMdLines;
  const otherTools = cfg.tools.some((t) => t !== 'claude');
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const full = join(repo, f);
    if (rootMdMode(cfg) === 'off' || !existsSync(full) || res.seeded.includes(f)) continue;
    const n = lineCount(read(full));
    if (n > max) res.notes.push(`${f}: ${n} lines > ${max} → run "/wiki slim" to move detail into ${mem}/ (or set rootMd.mode "off")`);
  }
  if (otherTools && existsSync(join(repo, 'CLAUDE.md')) && !/^@AGENTS\.md/m.test(read(join(repo, 'CLAUDE.md'))) && !res.seeded.includes('CLAUDE.md')) {
    res.notes.push('CLAUDE.md does not import @AGENTS.md (OpenCode/Codex read AGENTS.md only)');
  }
  if (cfg.tools.includes('codex') && cfg.tools.includes('opencode')) {
    res.notes.push('codex+opencode: set OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 to avoid duplicate skills in OpenCode');
  }

  if (!dry) {
    const worker = cfg.delegate?.opencodeAgent;
    const repoWorker = worker && cfg.tools.includes('opencode') && sel.src.agents.some((a) => a.kitName === worker) ? sel.names[worker] : worker;
    const manifest = {
      kit: cfg.version, syncedAt: new Date().toISOString(), tools: cfg.tools, packs, footprint: cfg.footprint || 'tracked',
      rootMd: { mode: rootMdMode(cfg), max }, memory: mem, delegate: { ...cfg.delegate, opencodeAgent: repoWorker },
      names: sel.installed, files, settings, seeds: seeded,
    };
    write(join(repo, MANIFEST), json(manifest));
  }
  res.overhead = dry ? null : overhead(repo);
  return { repo, cfg, packs, res };
}

export function report({ repo, cfg, packs, res }, dry) {
  const L = [];
  L.push(`agentry ${cfg.version}${dry ? ' (dry run)' : ''} → ${repo}`);
  L.push(`  tools: ${cfg.tools.join(', ')} · packs: ${packs.join(', ') || 'none'} · footprint: ${cfg.footprint || 'tracked'}${cfg.namespace ? ` · namespace: ${cfg.namespace}` : ''}`);
  L.push(`  +${res.added.length} new  ~${res.updated.length} updated  =${res.same.length} unchanged  -${res.removed.length} removed`);
  if (res.seeded.length) L.push(`  seeded: ${res.seeded.join(', ')}`);
  if (res.foreign.length) L.push(`  ! already in the repo, not installed by the kit (never overwritten; set "namespace" or exclude them): ${res.foreign.join(', ')}`);
  if (res.skipped.length) L.push(`  ! modified locally, skipped (use --force or move to .kit/local/): ${res.skipped.join(', ')}`);
  if (res.kept.length) L.push(`  ! no longer in kit but modified, kept: ${res.kept.join(', ')}`);
  if (res.settings.length) L.push('  settings:', ...res.settings.map((c) => `    ${c}`));
  for (const n of res.notes) L.push(`  • ${n}`);
  if (res.overhead) L.push(`  always-loaded context ≈ ${res.overhead.tokens} tokens (${res.overhead.items} descriptions + root md)`);
  return L.join('\n');
}
