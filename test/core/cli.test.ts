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

test('init without a TTY needs --agent; unknown agents rejected', async () => {
  const root = await repo();
  assert.match(cli(root, 'init').err, /pass --agent/);
  assert.equal(cli(root, 'init').code, 2);
  assert.match(cli(root, 'init', '--agent', 'nobody').err, /unknown agent nobody/);
});

test('init --dry-run writes nothing', async () => {
  const root = await repo({ 'a.txt': 'x' });
  const r = cli(root, 'init', '--agent', 'claude', '--dry-run');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /would create \.truthgate\/\.gitignore/);
  assert.match(r.out, /Dry run/);
  assert.ok(!existsSync(join(root, '.truthgate')));
  assert.ok(!existsSync(join(root, '.claude')));
});

test('init for an instruct-only agent installs the pre-commit hook by default and says so', async () => {
  const root = await repo({ 'a.txt': 'x' });
  const r = cli(root, 'init', '--agent=amp', '--yes');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /amp: instruct-only/);
  assert.match(r.out, /pre-commit hook/);
  assert.equal(await readFile(join(root, '.truthgate/.gitignore'), 'utf8'), 'state.json\nlast-run.json\n');
  assert.match(await readFile(join(root, '.git/hooks/pre-commit'), 'utf8'), /truthgate verify/);
  // Idempotent.
  const again = cli(root, 'init', '--agent', 'amp', '--yes');
  assert.equal(again.code, 0);
  assert.doesNotMatch(again.out, /^(create|merge|update) /m);
  assert.match(again.out, /and at every commit \(pre-commit hook\)/); // already installed: still a gate
});

test('R1-N4: init does not promise a commit gate when the existing hook is not sh', async () => {
  const root = await repo({ 'a.txt': 'x' });
  const { put } = await import('./helpers.ts');
  const py = '#!/usr/bin/env python3\nprint("mine")\n';
  await put(root, '.git/hooks/pre-commit', py);
  const r = cli(root, 'init', '--agent', 'amp', '--yes');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /amp: instruct-only/);
  assert.doesNotMatch(r.out, /at every commit/);
  assert.equal(await readFile(join(root, '.git/hooks/pre-commit'), 'utf8'), py);
  const fresh = cli(await repo({ 'a.txt': 'x' }), 'init', '--agent', 'amp', '--yes');
  assert.match(fresh.out, /and at every commit \(pre-commit hook\)/);
});

test('init records the baseline at HEAD (once), so commits before the first verify are still checked', async () => {
  const root = await repo({ 'a.txt': 'x' });
  assert.doesNotMatch(cli(root, 'init', '--agent', 'claude', '--dry-run').out, /Recorded the truthgate baseline/);
  assert.match(cli(root, 'init', '--agent', 'claude').out, /Recorded the truthgate baseline at \w{7} \(HEAD\)/);
  assert.doesNotMatch(cli(root, 'init', '--agent', 'claude').out, /Recorded the truthgate baseline/);
  assert.match(cli(root, 'status').out, /Baseline: \w{7} \(auto\)/);
});

test('init for an enforcing agent skips the pre-commit hook by default', async () => {
  const root = await repo({ 'a.txt': 'x' });
  assert.equal(cli(root, 'init', '--agent', 'claude', '--yes').code, 0);
  assert.ok(!existsSync(join(root, '.git/hooks/pre-commit')));
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

test('init --yes --dry-run plans Hypothesis only into a project environment (uv or .venv), never the system Python', async () => {
  const root = await repo({ 'pkg/a.py': 'x = 1\n', 'pyproject.toml': '[project]\nname = "p"\n' });
  const sys = cli(root, 'init', '--agent', 'claude', '--yes', '--dry-run');
  assert.equal(sys.code, 0, sys.err);
  assert.doesNotMatch(sys.out, /would run/);
  assert.match(sys.out, /no uv\.lock or \.venv to add Hypothesis to/);
  const { put } = await import('./helpers.ts');
  await put(root, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python', '');
  assert.match(cli(root, 'init', '--agent', 'claude', '--yes', '--dry-run').out, /would run: .*\.venv.* -m pip install hypothesis, then set python\.native .*commit \.truthgate\/config\.json/);
  await put(root, 'uv.lock', '');
  assert.match(cli(root, 'init', '--agent', 'claude', '--yes', '--dry-run').out, /would run: uv add --dev hypothesis/);
});

test('init --yes in a non-Python repo with stray .py scripts: no Hypothesis offer, no config written, verify not blocked', async () => {
  const root = await repo({ 'src/app.ts': 'export const x = 1;\n', 'scripts/tool.py': 'x = 1\n' });
  const r = cli(root, 'init', '--agent', 'claude', '--yes');
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /Hypothesis/);
  assert.ok(!existsSync(join(root, '.truthgate/config.json')));
  assert.equal(cli(root, 'verify').code, 0);
});

test('hook reads stdin and returns the installer output', async () => {
  const root = await repo({ 'README.md': 'x' });
  const r = spawnSync(process.execPath, [CLI, 'hook', '--agent', 'claude'], { cwd: root, encoding: 'utf8', input: '{"stop_hook_active": false}' });
  assert.equal(r.status, 0, r.stderr);
});

test('init without a TTY or --yes in a Python project prints the Hypothesis hint', async () => {
  const root = await repo({ 'a.py': 'x = 1\n', 'requirements.txt': '', 'uv.lock': '' });
  const r = cli(root, 'init', '--agent', 'claude', '--dry-run');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Python project found: rerun with --yes to add Hypothesis/);
});

test('a config value below 1 exits 2', async () => {
  const root = await repo({ '.truthgate/config.json': '{"budgetSeconds": 0}' });
  const r = cli(root, 'verify');
  assert.equal(r.code, 2);
  assert.match(r.err, /config\.json: budgetSeconds: must be at least 1/);
});
