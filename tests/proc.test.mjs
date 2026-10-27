import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { resolveBin, run } = await import('../hub/proc.mjs');

// npm's Windows shim shape: the target sits after "%dp0%\".
const shim = (target) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\${target}"   %*\r\n`;

test('resolveBin: .cmd shims resolve to the .exe or .js they wrap; others pass through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-'));
  writeFileSync(join(dir, 'native.cmd'), shim('node_modules\\@x\\native\\bin\\native.exe'));
  writeFileSync(join(dir, 'scripty.cmd'), shim('node_modules\\scripty\\cli.js'));
  writeFileSync(join(dir, 'both.exe'), '');
  writeFileSync(join(dir, 'both.cmd'), shim('other.exe'));
  const win = { platform: 'win32', path: `${dir};C:\\nowhere` };
  assert.deepEqual(resolveBin('native', win), [join(dir, 'node_modules\\@x\\native\\bin\\native.exe'), []]);
  assert.deepEqual(resolveBin('scripty', win), [process.execPath, [join(dir, 'node_modules\\scripty\\cli.js')]]);
  assert.deepEqual(resolveBin('both', win), [join(dir, 'both.exe'), []], 'a real .exe on PATH wins');
  assert.deepEqual(resolveBin('missing', win), ['missing', []]);
  assert.deepEqual(resolveBin('native', { platform: 'linux', path: dir }), ['native', []]);
  assert.deepEqual(resolveBin('C:/x/native', win), ['C:/x/native', []]);
});

test('run() starts a .cmd-shimmed CLI on Windows with exact arguments', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shimrun-'));
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'lib', 'echo.mjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  writeFileSync(join(dir, 'echoargs.cmd'), shim('lib\\echo.mjs'));
  const old = process.env.PATH;
  process.env.PATH = `${dir};${old}`;
  try {
    const args = ['--disallowedTools', 'PowerShell(git * push*)', 'a b', '"q"', ''];
    const r = await run('echoargs', args);
    assert.equal(r.code, 0, r.tail);
    assert.deepEqual(JSON.parse(r.out), args);
  } finally { process.env.PATH = old; }
});
