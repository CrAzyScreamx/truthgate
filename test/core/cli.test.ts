import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repo } from './helpers.ts';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const cli = (cwd: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', input: '' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('usage errors exit 2', async () => {
  const root = await repo();
  assert.equal(cli(root).code, 2);
  assert.equal(cli(root, '--help').code, 0);
  assert.match(cli(root, 'bogus').err, /unknown command "bogus"/);
  assert.equal(cli(root, 'verify', '--nope').code, 2);
  assert.equal(cli(root, 'verify', '--budget', 'abc').code, 2);
  assert.equal(cli(root, 'verify', '--budget').code, 2);
  assert.equal(cli(root, 'hook').code, 2);
  assert.equal(cli(root, 'hook', '--agent', 'nobody').code, 2);
  assert.equal(cli(root, 'shim').code, 2);
  assert.match(cli(root, 'shim', 'missing').err, /no spec with id "missing"/);
});

test('approve is gone: specs need no approval', async () => {
  const r = cli(await repo(), 'approve');
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command "approve"/);
});

test('accept lists the test/config changes it absorbs and moves the baseline to HEAD', async () => {
  const { put } = await import('./helpers.ts');
  const { execFileSync } = await import('node:child_process');
  const root = await repo({ 'tests/test_a.py': 'def test_a():\n    assert f(1) == 1\n    assert f(2) == 2\n' });
  assert.equal(cli(root, 'verify').code, 0); // records the baseline
  await put(root, 'tests/test_a.py', 'def test_a():\n    assert f(1) == 1\n');
  execFileSync('git', ['commit', '-qam', 'drop a case', '--no-verify'], { cwd: root });
  assert.equal(cli(root, 'verify').code, 1);
  assert.match(cli(root, 'status').out, /TAMPER\s+assert-removed\s+tests\/test_a\.py/);
  const r = cli(root, 'accept');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Accepting these changes since \w{7}:\n  assert-removed: tests\/test_a\.py[\s\S]*Baseline set to \w{7} \(HEAD\)/);
  assert.equal(cli(root, 'verify').code, 0);
  await put(root, 'tests/test_a.py', 'x = 1\n');
  assert.match(cli(root, 'accept').out, /Uncommitted changes are not accepted/);
  assert.match(cli(await repo(), 'accept').err, /no commits yet/);
});

test('status lists specs, the baseline, and spec edits since it', async () => {
  const { put } = await import('./helpers.ts');
  const SPEC = 'id: a\ntarget: src/a.py::f\nlang: python\ninputs: { x: "int[0,1]" }\nensures: [{ name: p, expr: "out == x" }]\n';
  const root = await repo({ '.truthgate/specs/a.yaml': SPEC });
  const r = cli(root, 'status');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^a\s+function\s+src\/a\.py::f$/m);
  assert.match(r.out, /Baseline: none recorded yet/);
  cli(root, 'verify');
  await put(root, '.truthgate/specs/a.yaml', SPEC.replace('out == x', 'true'));
  const s = cli(root, 'status').out;
  assert.match(s, /Baseline: \w{7} \(auto\)/);
  assert.match(s, /SPEC EDIT\s+spec a .* was changed since the baseline/);
});

test('bad spec files exit 2 with file and field', async () => {
  const root = await repo({ '.truthgate/specs/a.yaml': 'id: a\ntarget: nope\nlang: python\n' });
  const r = cli(root, 'status');
  assert.equal(r.code, 2);
  assert.match(r.err, /\.truthgate\/specs\/a\.yaml: target:/);
});

test('verify end to end on a js target: exit 1 on FALSIFIED, --json, shim for js and python', async () => {
  const root = await repo({ 'README.md': 'x' });
  const { put } = await import('./helpers.ts');
  await put(root, 'src/m.js', 'export function absv(x) { return x < 0 ? -x : x; }\nexport function bad(x) { return x < -5 ? x : Math.abs(x); }\n');
  const spec = (id: string, fn: string) => `id: ${id}\ntarget: src/m.js::${fn}\nlang: js\ninputs: { x: "int[-100,100]" }\nensures:\n  - { name: same, expr: "out == abs(x)" }\n`;
  await put(root, '.truthgate/specs/abs.yaml', spec('abs', 'absv'));
  let r = cli(root, 'verify');
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /TESTED\s+abs \/ same/);
  await put(root, '.truthgate/specs/bad.yaml', spec('bad', 'bad'));
  r = cli(root, 'verify', '--json', '--budget', '20');
  assert.equal(r.code, 1, r.err);
  const report = JSON.parse(r.out);
  assert.equal(report.blocking, true);
  assert.ok(report.verdicts.some((v: { specId: string; kind: string }) => v.specId === 'bad' && v.kind === 'FALSIFIED'));
  assert.ok(existsSync(join(root, '.truthgate/last-run.json')));

  assert.equal(cli(root, 'shim', 'abs').code, 0);
  await put(root, '.truthgate/specs/py.yaml', 'id: py\ntarget: src/p.py::f\nlang: python\ninputs: { x: "int[0,1]" }\nensures: [{ name: p, expr: "out == x" }]\n');
  r = cli(root, 'shim', 'py');
  assert.equal(r.code, 0, r.err);
  const path = /wrote (\S+)\./.exec(r.out)?.[1];
  assert.ok(path && existsSync(join(root, path)), r.out);
  assert.match(cli(root, 'shim', 'py').out, /already exists/);
  assert.match(cli(root, 'shim', 'py', '--force').out, /wrote/);
});

test('hook reads stdin and returns the installer output', async () => {
  const root = await repo({ 'README.md': 'x' });
  const r = spawnSync(process.execPath, [CLI, 'hook', '--agent', 'claude'], { cwd: root, encoding: 'utf8', input: '{"stop_hook_active": false}' });
  assert.equal(r.status, 0, r.stderr);
});

test('a config value below 1 exits 2', async () => {
  const root = await repo({ '.truthgate/config.json': '{"budgetSeconds": 0}' });
  const r = cli(root, 'verify');
  assert.equal(r.code, 2);
  assert.match(r.err, /config\.json: budgetSeconds: must be at least 1/);
});

test('every global plan stays under the home dir and marks its hook --global', async () => {
  const { installers } = await import('../../src/agents/index.ts');
  for (const inst of Object.values(installers)) {
    for (const c of (await inst.globalPlan?.()) ?? []) {
      assert.ok(!c.path.startsWith('/') && !c.path.includes('..'), `${inst.id}: ${c.path}`);
      if (c.content.includes('truthgate hook')) assert.match(c.content, /--global/, `${inst.id}: ${c.path}`);
    }
  }
});
