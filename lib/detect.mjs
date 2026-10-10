import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { globToRe, read, readJson, walk } from './util.mjs';

export function scan(repo, cfg) {
  const files = walk(repo, { maxDepth: cfg.detect.maxDepth, ignore: cfg.detect.ignoreDirs });
  const deps = new Set();
  const add = (n) => n && deps.add(n.toLowerCase());
  for (const f of files) {
    const name = basename(f).toLowerCase();
    try {
      if (name === 'package.json') {
        const p = readJson(join(repo, f), {});
        for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) Object.keys(p[k] || {}).forEach(add);
      } else if (name.endsWith('.csproj')) {
        for (const m of read(join(repo, f)).matchAll(/PackageReference\s+Include="([^"]+)"/g)) add(m[1]);
      } else if (/^requirements.*\.txt$/.test(name)) {
        for (const m of read(join(repo, f)).matchAll(/^\s*([A-Za-z0-9_.-]+)/gm)) add(m[1]);
      } else if (name === 'pyproject.toml' || name === 'pipfile') {
        for (const m of read(join(repo, f)).matchAll(/["']([A-Za-z0-9_.-]+)\s*(?:[<>=~!;[][^"']*)?["']/g)) add(m[1]);
        for (const m of read(join(repo, f)).matchAll(/^([A-Za-z0-9_.-]+)\s*=\s*["'{]/gm)) add(m[1]); // poetry/pipfile tables
      }
    } catch { /* unreadable manifest: ignore */ }
  }
  return { files, deps };
}

function matches(files, pattern) {
  const re = globToRe(pattern);
  return pattern.includes('/') ? files.some((f) => re.test(f)) : files.some((f) => re.test(basename(f)));
}

// "microsoft.entityframeworkcore" also matches "microsoft.entityframeworkcore.sqlserver".
const hasDep = (deps, d) => {
  const k = d.toLowerCase();
  return deps.has(k) || [...deps].some((x) => x.startsWith(`${k}.`));
};

export function detectPacks(repo, cfg, info = scan(repo, cfg)) {
  return Object.entries(cfg.packs)
    .filter(([, rule]) =>
      (rule.files || []).some((p) => matches(info.files, p)) ||
      (rule.deps || []).some((d) => hasDep(info.deps, d)))
    .map(([name]) => name);
}

// Best-effort build/test/lint commands for the AGENTS.md seed.
export function detectCommands(repo, info) {
  const cmds = { build: [], test: [], lint: [] };
  const push = (k, c) => c && !cmds[k].includes(c) && cmds[k].push(c);

  const pkgs = info.files.filter((f) => basename(f) === 'package.json').sort((a, b) => a.length - b.length);
  for (const f of pkgs.slice(0, 2)) {
    const dir = dirname(f);
    const p = readJson(join(repo, f), {});
    const has = (l) => existsSync(join(repo, dir, l)) || existsSync(join(repo, l));
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const run = (s) => (dir === '.' ? `${pm} ${pm === 'npm' ? 'run ' : ''}${s}` : pm === 'npm' ? `npm --prefix ${dir} run ${s}` : `${pm} --dir ${dir} ${s}`);
    for (const k of ['build', 'test', 'lint']) if (p.scripts?.[k]) push(k, run(k));
    if (!p.scripts?.build && p.scripts?.typecheck) push('build', run('typecheck'));
  }

  const sln = info.files.find((f) => /\.slnx?$/i.test(f)) || info.files.find((f) => /\.csproj$/i.test(f));
  if (sln) {
    push('build', `dotnet build ${sln}`);
    push('test', `dotnet test ${sln}`);
    push('lint', `dotnet format ${sln} --verify-no-changes`);
  }

  const py = info.files.find((f) => /(^|\/)(pyproject\.toml|requirements\.txt|setup\.py)$/.test(f));
  if (py) {
    const uv = info.files.some((f) => basename(f) === 'uv.lock');
    const poetry = info.files.some((f) => basename(f) === 'poetry.lock');
    const pre = uv ? 'uv run ' : poetry ? 'poetry run ' : '';
    push('test', `${pre}pytest -q`);
    push('lint', `${pre}ruff check .`);
  }
  return cmds;
}
