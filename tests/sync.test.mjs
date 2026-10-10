import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { lintWiki } from '../core/skills/wiki/scripts/wiki-lint.mjs';
import { sync } from '../lib/sync.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'kit-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'next build', test: 'vitest' }, dependencies: { next: '15', react: '19', '@supabase/supabase-js': '2' } }));
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
  writeFileSync(join(dir, 'tsconfig.json'), '{}');
  mkdirSync(join(dir, 'api'));
  writeFileSync(join(dir, 'api', 'pyproject.toml'), '[project]\ndependencies = ["fastapi>=0.110", "supabase>=2"]\n');
  return dir;
}
const r = (dir, p) => readFileSync(join(dir, p), 'utf8');

test('fresh sync installs detected packs, agents, commands, seeds', () => {
  const dir = fixture();
  const { packs, res } = sync(dir);
  assert.deepEqual(packs.sort(), ['nextjs', 'python', 'react', 'supabase', 'typescript']);
  for (const p of ['.claude/agents/reviewer.md', '.claude/skills/route/SKILL.md', '.claude/skills/supabase/SKILL.md', '.claude/commands/spec.md',
    '.claude/hooks/root-md-guard.mjs', '.opencode/agents/reviewer.md', '.opencode/agents/kit-worker.md', '.opencode/commands/wiki.md',
    'AGENTS.md', 'CLAUDE.md', '.wiki/index.md', '.wiki/plans/.gitkeep', '.kit/manifest.json']) assert.ok(existsSync(join(dir, p)), p);
  assert.ok(!existsSync(join(dir, '.claude/agents/kit-worker.md')), 'opencode-only agent not in claude');
  assert.ok(!existsSync(join(dir, '.opencode/agents/delegate.md')), 'claude-only agent not in opencode');
  assert.ok(!existsSync(join(dir, '.claude/commands/wiki.md')), 'opencode-only command not in claude');
  assert.ok(!existsSync(join(dir, '.claude/skills/dotnet')), 'undetected pack not installed');
  assert.ok(r(dir, 'AGENTS.md').trimEnd().split('\n').length <= 10);
  assert.match(r(dir, 'AGENTS.md'), /`pnpm build`/);
  assert.match(r(dir, '.claude/agents/explorer.md'), /tools: "?Read, Grep, Glob"?\nmodel: haiku/);
  assert.match(r(dir, '.opencode/agents/reviewer.md'), /mode: subagent\npermission:\n {2}edit: deny\n {2}bash:\n {4}"\*": allow\n {4}"git push\*": deny/);
  assert.match(r(dir, '.opencode/agents/kit-worker.md'), /mode: primary/);
  assert.match(r(dir, '.gitignore'), /\.kit\/handoff\//);
  assert.equal(res.skipped.length, 0);
  assert.deepEqual(lintWiki(join(dir, '.wiki')), []);
  rmSync(dir, { recursive: true, force: true });
});

test('re-sync is idempotent; local edits kept; --force overwrites; dropped pack removed', () => {
  const dir = fixture();
  sync(dir);
  let { res } = sync(dir);
  assert.equal(res.added.length + res.updated.length + res.removed.length, 0, JSON.stringify(res));

  writeFileSync(join(dir, '.claude/agents/reviewer.md'), 'my edit\n');
  ({ res } = sync(dir));
  assert.deepEqual(res.skipped, ['.claude/agents/reviewer.md']);
  assert.equal(r(dir, '.claude/agents/reviewer.md'), 'my edit\n');

  ({ res } = sync(dir, { force: true }));
  assert.ok(res.updated.includes('.claude/agents/reviewer.md'));

  ({ res } = sync(dir, { packs: 'typescript' }));
  assert.ok(res.removed.includes('.claude/skills/supabase/SKILL.md'));
  assert.ok(!existsSync(join(dir, '.claude/skills/supabase')), 'empty dir pruned');
  rmSync(dir, { recursive: true, force: true });
});

test('existing settings.json is merged, not replaced; .kit/local overrides win', () => {
  const dir = fixture();
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(pnpm test:*)'] }, model: 'sonnet' }));
  mkdirSync(join(dir, '.kit/local/agents'), { recursive: true });
  writeFileSync(join(dir, '.kit/local/agents/reviewer.md'), '---\nname: reviewer\ndescription: custom\ntools: [read]\n---\nCustom body\n');
  sync(dir);
  const s = JSON.parse(r(dir, '.claude/settings.json'));
  assert.equal(s.model, 'sonnet');
  assert.ok(s.permissions.allow.includes('Bash(pnpm test:*)') && s.permissions.allow.includes('Bash(git diff:*)'));
  assert.equal(s.hooks.PostToolUse.length, 1);
  sync(dir);
  assert.equal(JSON.parse(r(dir, '.claude/settings.json')).hooks.PostToolUse[0].hooks.length, 1, 'no duplicate hooks');
  assert.match(r(dir, '.claude/agents/reviewer.md'), /Custom body/);
  rmSync(dir, { recursive: true, force: true });
});

test('hooks: root-md guard blocks >10 lines, secret guard blocks .env reads', () => {
  const dir = fixture();
  sync(dir);
  const run = (hook, input) => {
    try { execFileSync('node', [join(dir, '.claude/hooks', hook)], { input: JSON.stringify(input), stdio: ['pipe', 'pipe', 'pipe'] }); return 0; } catch (e) { return e.status; }
  };
  writeFileSync(join(dir, 'CLAUDE.md'), Array(12).fill('x').join('\n'));
  assert.equal(run('root-md-guard.mjs', { tool_input: { file_path: join(dir, 'CLAUDE.md') } }), 2);
  writeFileSync(join(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  assert.equal(run('root-md-guard.mjs', { tool_input: { file_path: join(dir, 'CLAUDE.md') } }), 0);
  assert.equal(run('secret-guard.mjs', { tool_input: { command: 'cat .env' } }), 2);
  assert.equal(run('secret-guard.mjs', { tool_input: { command: 'cat apps/web/.env.local' } }), 2);
  assert.equal(run('secret-guard.mjs', { tool_input: { command: 'cat .env.example' } }), 0);
  assert.equal(run('secret-guard.mjs', { tool_input: { command: 'pnpm test' } }), 0);
  rmSync(dir, { recursive: true, force: true });
});

test('opencode-only install puts skills under .opencode/skills with rewritten paths', () => {
  const dir = fixture();
  sync(dir, { tools: 'opencode' });
  assert.ok(existsSync(join(dir, '.opencode/skills/delegate/SKILL.md')));
  assert.ok(!existsSync(join(dir, '.claude')));
  assert.match(r(dir, '.opencode/agents/reviewer.md'), /\.opencode\/skills\/review\/SKILL\.md/);
  rmSync(dir, { recursive: true, force: true });
});
