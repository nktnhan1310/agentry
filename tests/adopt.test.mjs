import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adopt } from '../lib/adopt.mjs';
import { report, sync } from '../lib/sync.mjs';
import { uninstall } from '../lib/uninstall.mjs';

const r = (dir, p) => readFileSync(join(dir, p), 'utf8');
const put = (dir, p, c) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), c); };
const git = (dir, ...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
const status = (dir) => git(dir, 'status', '--porcelain', '--untracked-files=all').trim();
const agent = (name) => `---\nname: ${name}\ndescription: project ${name}\n---\nProject body\n`;

// A repo with its own committed kit: agents, a tdd skill, tracked settings and a long CLAUDE.md.
function existingRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'kit-adopt-'));
  git(dir, 'init', '-q');
  put(dir, 'package.json', JSON.stringify({ dependencies: { react: '19' } }));
  put(dir, 'tsconfig.json', '{}');
  for (const a of ['planner', 'tester', 'code-reviewer', 'security-auditor', 'scout']) put(dir, `.claude/agents/${a}.md`, agent(a));
  put(dir, '.claude/skills/tdd/SKILL.md', '---\nname: tdd\ndescription: project tdd\n---\nOurs\n');
  put(dir, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(git diff:*)'] } }, null, 2) + '\n');
  put(dir, 'CLAUDE.md', Array.from({ length: 40 }, (_, i) => `rule ${i}`).join('\n') + '\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

test('adopt proposes namespace, roles, untracked footprint, rootMd off; --write keeps git clean', () => {
  const dir = existingRepo();
  const out = adopt(dir, { engines: [] });
  for (const s of ['"namespace": "ak"', '"reviewer": "code-reviewer"', '"security": "security-auditor"', '"explorer": "scout"',
    '"planner": "planner"', '"tdd": "tdd"', '"footprint": "untracked"', '"mode": "off"', '"templates": false', '"engine": "none"']) assert.ok(out.includes(s), s);
  assert.match(out, /name collisions with the kit: agents planner, tester · skills tdd/);
  assert.ok(!existsSync(join(dir, '.kit')), 'read-only without --write');
  adopt(dir, { write: true, engines: [] });
  assert.equal(status(dir), '');
  assert.throws(() => adopt(dir, { write: true, engines: [] }), /exists/);
  assert.doesNotMatch(adopt(dir, { engines: ['opencode'] }), /"engine"/, 'default engine available: no override');
  rmSync(dir, { recursive: true, force: true });
});

test('sync after adopt: namespaced, mapped, project files untouched, git status clean; uninstall restores', () => {
  const dir = existingRepo();
  adopt(dir, { write: true, engines: [] });
  const before = { settings: r(dir, '.claude/settings.json'), planner: r(dir, '.claude/agents/planner.md') };
  const { res } = sync(dir);
  assert.equal(status(dir), '', 'nothing to commit');
  assert.deepEqual(res.foreign, []);
  assert.equal(r(dir, '.claude/settings.json'), before.settings);
  assert.equal(r(dir, '.claude/agents/planner.md'), before.planner);
  for (const p of ['.claude/agents/ak-implementer.md', '.claude/skills/ak-route/SKILL.md', '.claude/commands/ak/spec.md', '.claude/hooks/ak-secret-guard.mjs'])
    assert.ok(existsSync(join(dir, p)), p);
  for (const p of ['.claude/agents/ak-reviewer.md', '.claude/agents/ak-planner.md', '.claude/agents/ak-delegate.md', '.claude/skills/ak-delegate', '.claude/skills/ak-tdd', '.claude/hooks/ak-root-md-guard.mjs', 'AGENTS.md', '.wiki', '.opencode', '.gitignore'])
    assert.ok(!existsSync(join(dir, p)), p);
  const route = r(dir, '.claude/skills/ak-route/SKILL.md');
  assert.match(route, /^---\nname: ak-route\n/);
  assert.match(route, /`code-reviewer`/);
  assert.match(route, /`ak-verify`/);
  assert.match(route, /`security-auditor`/);
  assert.match(r(dir, '.claude/agents/ak-implementer.md'), /`tdd`/);
  const local = JSON.parse(r(dir, '.claude/settings.local.json'));
  assert.ok(local.hooks.PreToolUse[0].hooks[0].command.includes('.claude/hooks/ak-secret-guard.mjs'));
  assert.ok(!local.hooks.PostToolUse, 'root-md guard off');
  assert.ok(!local.permissions.allow.some((x) => x.includes('delegate')), 'no delegate.mjs permission without an engine');
  assert.ok(local.permissions.allow.some((x) => x.includes('.claude/skills/ak-wiki/')));

  const again = sync(dir).res;
  assert.equal(again.added.length + again.updated.length + again.removed.length, 0, JSON.stringify(again));
  assert.match(report(sync(dir, { dry: true }), true), /namespace: ak/);

  const out = uninstall(dir);
  assert.match(out, /settings\.local\.json deleted/);
  assert.equal(status(dir), '', 'config stays hidden');
  assert.ok(!existsSync(join(dir, '.claude/skills/ak-route')) && !existsSync(join(dir, '.kit/manifest.json')));
  assert.ok(existsSync(join(dir, '.kit/config.json')));
  assert.equal(r(dir, '.claude/settings.json'), before.settings);
  rmSync(dir, { recursive: true, force: true });
});

test('a project file with a kit name is never overwritten, not even with --force', () => {
  const dir = existingRepo();
  const { res } = sync(dir, { force: true });
  assert.ok(res.foreign.includes('.claude/agents/planner.md'));
  assert.ok(res.foreign.includes('.claude/skills/tdd/SKILL.md'));
  assert.match(r(dir, '.claude/agents/planner.md'), /Project body/);
  rmSync(dir, { recursive: true, force: true });
});

test('install filters drop files and their settings entries; dangling references are reported', () => {
  const dir = existingRepo();
  put(dir, '.kit/config.json', JSON.stringify({ tools: ['claude'], install: { hooks: ['secret-guard'], commands: false, skills: ['route', 'verify'], templates: false } }));
  const { res } = sync(dir);
  assert.ok(!existsSync(join(dir, '.claude/commands')) || !existsSync(join(dir, '.claude/commands/spec.md')));
  assert.ok(!existsSync(join(dir, '.claude/skills/delegate')));
  const s = JSON.parse(r(dir, '.claude/settings.json'));
  assert.ok(!s.permissions.allow.some((x) => x.includes('delegate.mjs') || x.includes('wiki-lint')));
  assert.ok(!s.hooks.PostToolUse && s.hooks.PreToolUse);
  assert.ok(res.notes.some((n) => /"plan" is referenced by .*route/.test(n)), res.notes.join('\n'));
  rmSync(dir, { recursive: true, force: true });
});

test('settings: pre-existing entries survive re-sync and uninstall; kit entries come back out', () => {
  const dir = existingRepo();
  put(dir, '.kit/config.json', JSON.stringify({ namespace: 'ak', tools: ['claude'], install: { templates: false } }));
  sync(dir);
  let s = JSON.parse(r(dir, '.claude/settings.json'));
  assert.ok(s.permissions.allow.includes('Bash(git status:*)') && s.permissions.allow.includes('Bash(git diff:*)'));
  put(dir, '.kit/config.json', JSON.stringify({ namespace: 'ak', tools: ['claude'], install: { templates: false, hooks: false } }));
  sync(dir);
  s = JSON.parse(r(dir, '.claude/settings.json'));
  assert.ok(!s.hooks, 'hooks the kit added were removed once excluded');
  uninstall(dir);
  s = JSON.parse(r(dir, '.claude/settings.json'));
  assert.deepEqual(s, { permissions: { allow: ['Bash(git diff:*)'] } });
  rmSync(dir, { recursive: true, force: true });
});

test('rootMd warn: hook adds context instead of blocking', () => {
  const dir = existingRepo();
  put(dir, '.kit/config.json', JSON.stringify({ namespace: 'ak', rootMd: { mode: 'warn' } }));
  sync(dir);
  const out = execFileSync('node', [join(dir, '.claude/hooks/ak-root-md-guard.mjs')], {
    input: JSON.stringify({ tool_input: { file_path: join(dir, 'CLAUDE.md') } }), env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8',
  });
  assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /CLAUDE\.md has 40 lines/);
  rmSync(dir, { recursive: true, force: true });
});

test('memory.dir moves the seed and every .wiki reference; local packs install (namespaced)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-mem-'));
  put(dir, 'package.json', JSON.stringify({ dependencies: { '@angular/core': '17' } }));
  put(dir, '.kit/local/packs/acme/SKILL.md', '---\nname: acme\ndescription: house rules\n---\nAcme\n');
  put(dir, '.kit/config.json', JSON.stringify({ namespace: 'x', memory: { dir: 'docs/ai' }, tools: ['claude'] }));
  const { packs } = sync(dir);
  assert.ok(packs.includes('angular') && packs.includes('acme'));
  assert.ok(existsSync(join(dir, 'docs/ai/index.md')) && !existsSync(join(dir, '.wiki')));
  assert.match(r(dir, '.claude/skills/x-route/SKILL.md'), /docs\/ai\/index\.md/);
  assert.doesNotMatch(r(dir, '.claude/skills/x-route/SKILL.md'), /\.wiki/);
  assert.match(r(dir, '.claude/skills/x-wiki/scripts/wiki-lint.mjs'), /'docs\/ai'/);
  assert.match(r(dir, '.claude/skills/x-acme/SKILL.md'), /^---\nname: x-acme\n/);
  assert.match(r(dir, '.claude/skills/x-angular/SKILL.md'), /^---\nname: x-angular\n/);
  rmSync(dir, { recursive: true, force: true });
});

test('delegate.engine "none": no delegate files, no opencode/delegable text, no leftover markers', () => {
  const dir = existingRepo();
  put(dir, '.kit/config.json', JSON.stringify({ tools: ['claude'], namespace: 'ak', roles: { implementer: 'planner' }, delegate: { engine: 'none' } }));
  const { res } = sync(dir);
  assert.deepEqual(res.notes.filter((n) => /referenced/.test(n)), [], 'no dangling references');
  assert.ok(!existsSync(join(dir, '.claude/agents/ak-delegate.md')) && !existsSync(join(dir, '.claude/skills/ak-delegate')));
  const all = Object.keys(JSON.parse(r(dir, '.kit/manifest.json')).files).map((p) => r(dir, p)).join('\n');
  assert.doesNotMatch(all, /\{\{[#^/]\w+\}\}/);
  assert.doesNotMatch(all, /opencode|delegable|`ak-delegate`/i);
  assert.match(r(dir, '.claude/skills/ak-execute/SKILL.md'), /- Everything else → `planner` agent\./);
  assert.match(r(dir, '.claude/skills/ak-route/SKILL.md'), /in chat → implement → `ak-verify`/);
  assert.match(r(dir, '.claude/skills/ak-plan/SKILL.md'), /· size S\|M\n/);
  assert.match(r(dir, '.claude/commands/ak/impl.md'), /follow the `ak-execute` skill \(`planner` agent\)/);
  assert.match(sync(dir, { dry: true }).cfg.delegate.engine, /none/);
  rmSync(dir, { recursive: true, force: true });
});

test('delegate.engine "opencode" (default): delegate text kept, markers stripped', () => {
  const dir = existingRepo();
  put(dir, '.kit/config.json', JSON.stringify({ tools: ['claude'], namespace: 'ak' }));
  sync(dir);
  const route = r(dir, '.claude/skills/ak-route/SKILL.md');
  assert.match(route, /implement or `ak-delegate` → `ak-verify`/);
  assert.match(route, /→ `ak-delegate` \(runs on opencode/);
  assert.match(r(dir, '.claude/skills/ak-execute/SKILL.md'), /`delegable yes` → `ak-delegate` agent[\s\S]*- Otherwise → `ak-implementer` agent/);
  assert.ok(existsSync(join(dir, '.claude/skills/ak-delegate/scripts/delegate.mjs')));
  assert.doesNotMatch(route + r(dir, '.claude/agents/ak-implementer.md'), /\{\{/);
  put(dir, '.kit/config.json', '{"delegate":{"engine":"ollama"}}');
  assert.throws(() => sync(dir), /delegate\.engine "ollama"/);
  rmSync(dir, { recursive: true, force: true });
});
