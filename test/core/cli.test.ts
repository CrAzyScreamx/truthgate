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

test('approve refuses without a TTY', async () => {
  const r = cli(await repo(), 'approve');
  assert.equal(r.code, 2);
  assert.match(r.err, /interactive terminal/);
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

test('init for an enforcing agent skips the pre-commit hook by default', async () => {
  const root = await repo({ 'a.txt': 'x' });
  assert.equal(cli(root, 'init', '--agent', 'claude', '--yes').code, 0);
  assert.ok(!existsSync(join(root, '.git/hooks/pre-commit')));
});

test('status lists specs with their approval state', async () => {
  const root = await repo({
    '.truthgate/specs/a.yaml': 'id: a\ntarget: src/a.py::f\nlang: python\ninputs: { x: "int[0,1]" }\nensures: [{ name: p, expr: "out == x" }]\n',
  });
  const r = cli(root, 'status');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^a\s+pending\s+function\s+src\/a\.py::f$/m);
  assert.match(r.out, /1 spec\(s\) need approval/);
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

test('init --yes --dry-run with Python files plans the Hypothesis install', async () => {
  const root = await repo({ 'pkg/a.py': 'x = 1\n' });
  const r = cli(root, 'init', '--agent', 'claude', '--yes', '--dry-run');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /would run: .*-m pip install hypothesis, then set python\.native/);
  const { put } = await import('./helpers.ts');
  await put(root, 'uv.lock', '');
  assert.match(cli(root, 'init', '--agent', 'claude', '--yes', '--dry-run').out, /would run: uv add --dev hypothesis/);
});

test('hook reads stdin and returns the installer output', async () => {
  const root = await repo({ 'README.md': 'x' });
  const r = spawnSync(process.execPath, [CLI, 'hook', '--agent', 'claude'], { cwd: root, encoding: 'utf8', input: '{"stop_hook_active": false}' });
  assert.equal(r.status, 0, r.stderr);
});

test('init without a TTY or --yes in a Python repo prints the Hypothesis hint', async () => {
  const root = await repo({ 'a.py': 'x = 1\n' });
  const r = cli(root, 'init', '--agent', 'claude', '--dry-run');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Python found: rerun with --yes to add Hypothesis/);
});

test('a config value below 1 exits 2', async () => {
  const root = await repo({ '.truthgate/config.json': '{"budgetSeconds": 0}' });
  const r = cli(root, 'verify');
  assert.equal(r.code, 2);
  assert.match(r.err, /config\.json: budgetSeconds: must be at least 1/);
});
