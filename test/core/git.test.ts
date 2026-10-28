import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { LanguageAdapter } from '../../src/contract.ts';
import { changedFiles, NotGitError } from '../../src/core/diff.ts';
import { detectTamper } from '../../src/core/tamper.ts';
import { APPROVALS_FILE, approvalStates, checkApprovals, describeSpec, runApprove, specHash } from '../../src/core/approve.ts';
import { loadSpecs } from '../../src/core/spec.ts';
import { repo, put } from './helpers.ts';


test('changedFiles: modified, staged, untracked, deleted; ignores .gitignore', async () => {
  const root = await repo({ 'a.py': '1', 'b.py': '1', 'c.py': '1', '.gitignore': 'ignored.txt\n' });
  assert.deepEqual(await changedFiles(root), []);
  await put(root, 'a.py', '2');
  await put(root, 'b.py', '2');
  execFileSync('git', ['add', 'b.py'], { cwd: root });
  await rm(join(root, 'c.py'));
  await put(root, 'sub dir/new ü.py', 'x');
  await put(root, 'ignored.txt', 'x');
  assert.deepEqual(await changedFiles(root), ['a.py', 'b.py', 'c.py', 'sub dir/new ü.py']);
});

test('changedFiles: no commits means every file; subdir root is relative', async () => {
  const root = await repo({ 'a.py': '1', 'pkg/b.py': '1' }, false);
  execFileSync('git', ['add', 'a.py'], { cwd: root });
  assert.deepEqual(await changedFiles(root), ['a.py', 'pkg/b.py']);
  const r2 = await repo({ 'pkg/b.py': '1', 'top.py': '1' });
  await put(r2, 'pkg/b.py', '2');
  await put(r2, 'top.py', '2');
  assert.deepEqual(await changedFiles(join(r2, 'pkg')), ['b.py']);
});

test('changedFiles: not a repo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tg-nogit-'));
  await assert.rejects(changedFiles(root), NotGitError);
});

const fakePy: LanguageAdapter = {
  lang: 'python',
  available: async () => true,
  open: async () => {
    throw new Error('unused');
  },
  shimTemplate: () => ({ path: '', source: '' }),
  testFileGlobs: ['**/test_*.py'],
  skipMarkers: [/@pytest\.mark\.(skip|xfail)/],
  assertPatterns: [/\bassert\b/],
  lineComment: '#',
};

test('detectTamper: assert-removed, skip-added, test-deleted; new and non-test files ignored', async () => {
  const T = 'def test_a():\n    assert f(1) == 1\n    assert f(2) == 2\n\n@pytest.mark.skip\ndef test_b():\n    assert True\n';
  const root = await repo({ 'tests/test_a.py': T, 'tests/test_gone.py': T, 'tests/test_ok.py': T, 'src/x.py': 'assert 1' });
  await put(root, 'tests/test_a.py', T.replace('    assert f(2) == 2\n', '').replace('def test_a', '@pytest.mark.xfail\ndef test_a'));
  await rm(join(root, 'tests/test_gone.py'));
  await put(root, 'tests/test_ok.py', T.replace(/\n/g, '\r\n') + '\ndef test_c():\n    assert 3\n');
  await put(root, 'tests/test_new.py', '@pytest.mark.skip\ndef test_n(): pass\n');
  await put(root, 'src/x.py', '');
  const f = await detectTamper(root, await changedFiles(root), [fakePy]);
  assert.deepEqual(
    f.map((x) => [x.file, x.rule, x.line]),
    [
      ['tests/test_a.py', 'assert-removed', undefined],
      ['tests/test_a.py', 'skip-added', 1],
      ['tests/test_gone.py', 'test-deleted', undefined],
    ],
  );
  assert.match(f[0]!.detail, /from 3 to 2/);
});

const SPEC = (n: number) => `id: s${n}\ntarget: src/x.py::f\nlang: python\ninputs: { a: "int[0,9]" }\nrequires: ["a > 0"]\nensures:\n  - name: ok\n    expr: "out == a"\n`;

const io = (answers: string) => {
  const input = new PassThrough();
  input.end(answers);
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => (text += d));
  return { io: { input, output, isTTY: true }, text: () => text };
};

test('approve refuses without a TTY', async () => {
  const root = await repo();
  const { io: x } = io('y\n');
  assert.equal(await runApprove(root, { ...x, isTTY: false }), 2);
});

test('approve flow, approval states and checkApprovals rules', async () => {
  const root = await repo({ '.truthgate/specs/s1.yaml': SPEC(1), '.truthgate/specs/s2.yaml': SPEC(2) });
  let specs = await loadSpecs(root);
  assert.deepEqual(await checkApprovals(root, specs), []);
  assert.deepEqual(await approvalStates(root, specs), { s1: 'pending', s2: 'pending' });

  const a = io('y\nno\n');
  assert.equal(await runApprove(root, a.io), 0);
  assert.match(a.text(), /NEW s1[\s\S]*a: an integer from 0 to 9[\s\S]*a > 0[\s\S]*ok: out == a[\s\S]*Approve s1\? \[y\/N\]/);
  assert.match(a.text(), /Left s2 unapproved/);
  assert.deepEqual(await approvalStates(root, specs), { s1: 'approved', s2: 'pending' });
  assert.deepEqual(await checkApprovals(root, specs), []);

  // CRLF checkout of the same spec keeps the same hash.
  await put(root, '.truthgate/specs/s1.yaml', SPEC(1).replace(/\n/g, '\r\n'));
  assert.deepEqual(await checkApprovals(root, specs), []);
  assert.equal(specHash('a\r\nb'), specHash('a\nb'));

  await put(root, '.truthgate/specs/s1.yaml', SPEC(1).replace('a > 0', 'a > 1'));
  assert.deepEqual((await checkApprovals(root, specs)).map((f) => f.rule), ['spec-changed']);
  assert.deepEqual(await approvalStates(root, specs), { s1: 'changed', s2: 'pending' });
  const b = io('y\ny\n');
  assert.equal(await runApprove(root, b.io), 0);
  assert.match(b.text(), /CHANGED s1/);
  assert.deepEqual(await approvalStates(root, specs), { s1: 'approved', s2: 'approved' });

  // Nothing left to approve.
  const c = io('');
  assert.equal(await runApprove(root, c.io), 0);
  assert.match(c.text(), /All specs are approved/);

  await rm(join(root, '.truthgate/specs/s2.yaml'));
  specs = await loadSpecs(root);
  assert.deepEqual((await checkApprovals(root, specs)).map((f) => f.rule), ['spec-deleted']);
  const d = io('');
  await runApprove(root, d.io);
  assert.match(d.text(), /Removed the approval for deleted spec "s2"/);
  assert.deepEqual(await checkApprovals(root, specs), []);

  // Hand edit: integrity no longer matches; approvals are not trusted.
  const raw = JSON.parse(await readFile(join(root, APPROVALS_FILE), 'utf8'));
  raw.specs.s9 = { sha256: 'x', approvedAt: 'now' };
  await writeFile(join(root, APPROVALS_FILE), JSON.stringify(raw));
  assert.deepEqual((await checkApprovals(root, specs)).map((f) => f.rule), ['approvals-edited', 'spec-deleted']);
  assert.deepEqual(await approvalStates(root, specs), { s1: 'pending' });
  const e = io('y\n');
  await runApprove(root, e.io);
  assert.match(e.text(), /edited outside/);
  assert.deepEqual(await checkApprovals(root, specs), []);

  await writeFile(join(root, APPROVALS_FILE), '{bad');
  assert.deepEqual((await checkApprovals(root, specs)).map((f) => f.rule), ['approvals-edited']);
});

test('checkApprovals: deleting a committed approvals file is tampering', async () => {
  const root = await repo({ '.truthgate/specs/s1.yaml': SPEC(1) });
  await runApprove(root, io('y\n').io);
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'approve'], { cwd: root });
  await rm(join(root, APPROVALS_FILE));
  assert.deepEqual((await checkApprovals(root, await loadSpecs(root))).map((f) => f.rule), ['approvals-edited']);
});

test('describeSpec covers sequence specs', () => {
  const text = describeSpec({
    id: 'q', target: 'w.go::W', lang: 'go', kind: 'sequence', inputs: {}, requires: [], ensures: [], file: 'q.yaml',
    ops: [{ name: 'take', inputs: { n: 'int[1,5]' } }], invariant: [{ name: 'nonneg', expr: 'state.n >= 0' }], allowCrash: true,
    prove: { tool: 'rocq', file: 'p.v', theorem: 't' },
  });
  assert.match(text, /take\n\s+n: an integer from 1 to 5/);
  assert.match(text, /nonneg: state\.n >= 0/);
  assert.match(text, /crash is not/);
  assert.match(text, /Proof: rocq p\.v, t/);
});
