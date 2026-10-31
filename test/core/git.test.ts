import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageAdapter } from '../../src/contract.ts';
import { changedFiles, commitOf, NotGitError } from '../../src/core/diff.ts';
import { checkConfig, CONSTANT_ASSERTS, detectTamper, specChanges } from '../../src/core/tamper.ts';
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
      ['tests/test_new.py', 'skip-added', 1],
    ],
  );
  assert.match(f[0]!.detail, /1 assertion line\(s\) removed or changed since the baseline, e\.g\. `assert f\(2\) == 2`/);
});

test('detectTamper: comment-outs, changed and constant asserts, renames, commits after the baseline', async () => {
  const T = 'def test_a():\n    assert f(1) == 1\n    assert f(2) == 2\n';
  const root = await repo({ 'tests/test_c.py': T, 'tests/test_d.py': T, 'tests/test_r.py': T, 'tests/test_k.py': T });
  const base = (await import('../../src/core/diff.ts')).commitOf(root, 'HEAD');
  await put(root, 'tests/test_c.py', T.replace('    assert f(2) == 2', '    # assert f(2) == 2'));
  await put(root, 'tests/test_d.py', T.replace('assert f(2) == 2', 'assert f(2) == 3  # same count'));
  await put(root, 'tests/test_k.py', T + '\ndef test_x():\n    assert True\n    assert 1 == 1\n    assert f(3) == 3  # assert True\n');
  execFileSync('git', ['mv', 'tests/test_r.py', 'tests/test_s.py'], { cwd: root });
  await put(root, 'tests/test_s.py', T.replace('    assert f(2) == 2\n', ''));
  // The agent commits everything: HEAD moves, the baseline does not.
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'hide it', '--no-verify'], { cwd: root });
  const b = (await base)!;
  const f = await detectTamper(root, await changedFiles(root, b), [fakePy], b);
  assert.deepEqual(
    f.map((x) => [x.file, x.rule, x.line ?? null, x.detail.split(':')[0]]),
    [
      ['tests/test_c.py', 'assert-removed', null, '1 assertion line(s) removed or changed since the baseline, e.g. `assert f(2) == 2`'],
      ['tests/test_d.py', 'assert-removed', null, '1 assertion line(s) removed or changed since the baseline, e.g. `assert f(2) == 2`'],
      ['tests/test_k.py', 'assert-removed', 6, 'constant assertion'],
      ['tests/test_k.py', 'assert-removed', 7, 'constant assertion'],
      ['tests/test_r.py', 'test-deleted', null, 'test file deleted'],
    ],
  );
  // Against the moved HEAD, the same commit would hide everything.
  assert.deepEqual(await detectTamper(root, await changedFiles(root), [fakePy], 'HEAD'), []);
});

test('F3-noise: src/**/*.rs counts as a test file only with #[cfg(test)]', async () => {
  const fakeRs: LanguageAdapter = {
    ...fakePy, lang: 'rust', testFileGlobs: ['**/tests/**/*.rs', '**/src/**/*.rs'],
    skipMarkers: [/#\[ignore\]/], assertPatterns: [/\bassert(_eq|_ne)?!\s*\(/], lineComment: '//',
  };
  const PLAIN = 'pub fn f() -> i32 {\n    assert!(true);\n    1\n}\n';
  const WITH = 'pub fn f() -> i32 { 1 }\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { assert_eq!(super::f(), 1); }\n}\n';
  const root = await repo({ 'src/plain.rs': PLAIN, 'src/gone.rs': PLAIN, 'crate/src/inline.rs': WITH, 'src/inline_gone.rs': WITH, 'tests/it.rs': 'fn t() { assert!(f()); }\n' });
  await put(root, 'src/plain.rs', 'pub fn f() -> i32 { 2 }\n'); // refactor drops an assert!: not a test file
  await rm(join(root, 'src/gone.rs'));
  await put(root, 'crate/src/inline.rs', WITH.replace('    #[test]', '    #[test]\n    #[ignore]').replace('assert_eq!(super::f(), 1);', ''));
  await rm(join(root, 'src/inline_gone.rs'));
  await put(root, 'src/new_plain.rs', 'fn g() { assert!(true); }\n');
  await put(root, 'src/new_tests.rs', '#[cfg(test)]\nmod t {\n    #[test]\n    #[ignore]\n    fn x() {}\n}\n');
  await rm(join(root, 'tests/it.rs'));
  const f = await detectTamper(root, await changedFiles(root), [fakeRs]);
  assert.deepEqual(f.map((x) => [x.file, x.rule]), [
    ['crate/src/inline.rs', 'assert-removed'],
    ['crate/src/inline.rs', 'skip-added'],
    ['src/inline_gone.rs', 'test-deleted'],
    ['src/new_tests.rs', 'skip-added'],
    ['tests/it.rs', 'test-deleted'],
  ]);
});

test('CONSTANT_ASSERTS covers each framework and leaves real asserts alone', () => {
  const hit = (l: string) => CONSTANT_ASSERTS.some((p) => l.search(p) >= 0);
  for (const l of ['assert True', 'assert 1 == 1', 'expect(true).toBe(true);', 'expect(1).toBe(1)', 'assertTrue(true);', 'Assert.True(true);', 'assert!(true);', 'assert_eq!(1, 1);', 'assertEquals(x, x);', 'Assert.Equal(2, 2);', 'assert.ok(true)'])
    assert.ok(hit(l), l);
  for (const l of ['assert f(1) == 1', 'expect(f(1)).toBe(1)', 'assertTrue(ok);', 'assert_eq!(f(1), 1);', 'Assert.True(x > 0);', 'assert x == y'])
    assert.ok(!hit(l), l);
});

const SPEC = (n: number) => `id: s${n}\ntarget: src/x.py::f\nlang: python\ninputs: { a: "int[0,9]" }\nrequires: ["a > 0"]\nensures:\n  - name: ok\n    expr: "out == a"\n`;

test('specChanges: edited and deleted specs since the baseline warn; new specs and line endings do not', async () => {
  const root = await repo({ '.truthgate/specs/s1.yaml': SPEC(1), '.truthgate/specs/s2.yaml': SPEC(2), '.truthgate/specs/s3.yaml': SPEC(3) });
  const base = (await commitOf(root, 'HEAD'))!;
  await put(root, '.truthgate/specs/s1.yaml', SPEC(1).replace('out == a', 'true'));
  await rm(join(root, '.truthgate/specs/s2.yaml'));
  await put(root, '.truthgate/specs/s3.yaml', SPEC(3).replace(/\n/g, '\r\n'));
  await put(root, '.truthgate/specs/s4.yaml', SPEC(4));
  // Committing does not hide it: the comparison is with the baseline, not HEAD.
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'weaken', '--no-verify'], { cwd: root });
  const got = await specChanges(root, await loadSpecs(root), await changedFiles(root, base), base);
  assert.equal(got.length, 2, got.join('\n'));
  assert.match(got[0]!, /^spec s1 \(\.truthgate\/specs\/s1\.yaml\) was changed since the baseline \w{7}: check it was not weakened$/);
  assert.match(got[1]!, /^spec file \.truthgate\/specs\/s2\.yaml was deleted since the baseline/);
});

test('checkConfig: config.json compared with the baseline, line endings ignored, commits do not hide it', async () => {
  const root = await repo({ '.truthgate/config.json': '{"budgetSeconds": 30}\n' });
  const base = (await commitOf(root, 'HEAD'))!;
  assert.deepEqual(await checkConfig(root, base), []);
  await put(root, '.truthgate/config.json', '{"budgetSeconds": 30}\r\n');
  assert.deepEqual(await checkConfig(root, base), []);
  await put(root, '.truthgate/config.json', '{"budgetSeconds": 1}\n');
  assert.deepEqual((await checkConfig(root, base)).map((f) => f.rule), ['config-edited']);
  assert.match((await checkConfig(root, base))[0]!.detail, /npx truthgate accept/);
  execFileSync('git', ['commit', '-qam', 'cfg', '--no-verify'], { cwd: root });
  assert.deepEqual((await checkConfig(root, base)).map((f) => f.rule), ['config-edited']);
  assert.deepEqual(await checkConfig(root, (await commitOf(root, 'HEAD'))!), []); // after accept moves the baseline
  await rm(join(root, '.truthgate/config.json'));
  assert.deepEqual((await checkConfig(root, base)).map((f) => f.rule), ['config-edited']);
});

test('baseline: missing or vanished records fall back to HEAD; a record survives HEAD moving', async () => {
  const { readBaseline, writeBaseline } = await import('../../src/core/baseline.ts');
  const root = await repo({ 'a.txt': '1' });
  const head = await commitOf(root, 'HEAD');
  assert.deepEqual(await readBaseline(root), { commit: head, source: 'head' });
  await writeBaseline(root, { commit: head!, source: 'auto' });
  await put(root, 'a.txt', '2');
  execFileSync('git', ['commit', '-qam', 'next'], { cwd: root });
  assert.deepEqual(await readBaseline(root), { commit: head, source: 'auto' }); // HEAD moved, the baseline did not
  await writeBaseline(root, { commit: 'f'.repeat(40), source: 'accept' });
  assert.deepEqual(await readBaseline(root), { commit: await commitOf(root, 'HEAD'), source: 'head' });
  assert.deepEqual(await readBaseline(await repo()), { commit: '', source: 'head' });
});
