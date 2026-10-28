import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { Lang, Spec } from '../../src/contract.ts';
import { globToRegExp } from '../../src/core/glob.ts';
import { argOrder, safeId, shimCommand } from '../../src/lang/common.ts';
import { goTemplate } from '../../src/lang/go/adapter.ts';
import { adapters, getAdapter } from '../../src/lang/index.ts';
import { pythonCmd } from '../../src/lang/python/adapter.ts';
import { rustTemplate } from '../../src/lang/rust/adapter.ts';

const spec = (over: Partial<Spec>): Spec => ({
  id: 'a.b-c',
  target: 'src/x.py::f',
  lang: 'python',
  kind: 'function',
  inputs: { b: 'int[0,1]', a: 'list<int[0,1]>' },
  requires: [],
  ensures: [{ name: 'p', expr: 'true' }],
  file: 'x.yaml',
  ...over,
});

test('getAdapter covers every Lang; unknown throws', () => {
  for (const l of ['python', 'ts', 'js', 'java', 'csharp', 'go', 'rust'] as Lang[]) assert.equal(getAdapter(l).lang, l);
  assert.throws(() => getAdapter('cobol' as Lang));
  assert.equal(adapters.length, 7);
});

test('argOrder follows spec inputs, or the op inputs for sequences', () => {
  assert.deepEqual(argOrder(spec({}), 'f'), ['b', 'a']);
  const s = spec({ kind: 'sequence', ops: [{ name: 'add', inputs: { z: 'int[0,1]', y: 'bool' } }] });
  assert.deepEqual(argOrder(s, 'add'), ['z', 'y']);
});

test('shimCommand substitutes {root}/{shim} and resolves cwd', () => {
  const root = resolve('/repo');
  assert.deepEqual(shimCommand(spec({}), root, 'S', ['d']), { command: ['d'], cwd: root });
  const r = shimCommand(spec({ shim: { command: ['go', 'run', '{shim}', '{root}'], cwd: 'sub' } }), root, 'S', []);
  assert.deepEqual(r, { command: ['go', 'run', 'S', root], cwd: resolve(root, 'sub') });
  assert.equal(safeId('a.b-c'), 'a_b_c');
});

test('pythonCmd: system python without uv.lock or .venv', () => {
  assert.deepEqual(pythonCmd(resolve('fixtures/python')), [process.platform === 'win32' ? 'python' : 'python3']);
});

test('skip markers and assert patterns match the plan list', () => {
  const hit = (l: Lang, line: string, k: 'skipMarkers' | 'assertPatterns') => getAdapter(l)[k].some((r) => r.test(line));
  assert.ok(hit('python', '@pytest.mark.skip(reason="x")', 'skipMarkers'));
  assert.ok(hit('python', '@pytest.mark.xfail', 'skipMarkers'));
  assert.ok(hit('ts', "it.skip('x', () => {})", 'skipMarkers'));
  assert.ok(hit('ts', "xit('x', () => {})", 'skipMarkers'));
  assert.ok(hit('js', "describe.skip('x')", 'skipMarkers'));
  assert.ok(hit('java', '  @Disabled', 'skipMarkers'));
  assert.ok(hit('csharp', '[Fact(Skip = "flaky")]', 'skipMarkers'));
  assert.ok(hit('go', '\tt.Skip("later")', 'skipMarkers'));
  assert.ok(hit('rust', '#[ignore]', 'skipMarkers'));
  assert.ok(!hit('ts', "it('skips nothing', () => {})", 'skipMarkers'));
  assert.ok(hit('python', '    assert x == 1', 'assertPatterns'));
  assert.ok(hit('ts', 'expect(x).toBe(1);', 'assertPatterns'));
  assert.ok(hit('java', 'assertEquals(1, x);', 'assertPatterns'));
  assert.ok(hit('csharp', 'Assert.Equal(1, x);', 'assertPatterns'));
  assert.ok(hit('go', 't.Fatalf("bad")', 'assertPatterns'));
  assert.ok(hit('rust', 'assert_eq!(a, b);', 'assertPatterns'));
  for (const a of adapters) assert.ok(a.lineComment && a.testFileGlobs.length);
});

test('round-1 skip forms are caught (R1-09b)', () => {
  const hit = (l: Lang, line: string) => getAdapter(l).skipMarkers.some((r) => r.test(line));
  for (const line of ['pytestmark = pytest.mark.skip(reason="x")', 'pytestmark = [pytest.mark.xfail]', '        self.skipTest("later")', 'pytest.importorskip("numpy")'])
    assert.ok(hit('python', line), line);
  for (const line of ["test.only('x', () => {})", "it.only('x')", "describe.only('x')", "test.skipIf(true)('x', () => {})", "it.todo('x')", "test('x', { only: true }, () => {})"])
    assert.ok(hit('ts', line), line);
  for (const line of ['@DisabledIf("x")', '@DisabledOnOs(OS.WINDOWS)', 'assumeTrue(false);', 'Assumptions.assumeTrue(false, "x");', 'assumeFalse(true);'])
    assert.ok(hit('java', line), line);
  for (const line of ['[Theory(DisplayName = "x", Skip = "y")]', '[Test, Ignore("x")]', '[Explicit]', 'Assert.Ignore("x");', 'Skip.If(true);'])
    assert.ok(hit('csharp', line), line);
  assert.ok(hit('go', 'b.Skip("slow")'));
  assert.ok(hit('rust', '#[ignore = "slow"]'));
  assert.ok(hit('rust', '#[cfg_attr(windows, ignore)]'));
  assert.ok(!hit('ts', "it('only runs once', () => {})"));
  assert.ok(!hit('python', 'def test_skip_logic():'));
});

test('rust test globs include src/**/*.rs (inline #[cfg(test)] modules, F3)', () => {
  const globs = getAdapter('rust').testFileGlobs.map(globToRegExp);
  for (const f of ['src/lib.rs', 'src/a/b.rs', 'crates/x/src/lib.rs', 'tests/it.rs']) assert.ok(globs.some((g) => g.test(f)), f);
});

test('generic shim templates (python, ts, js, java, csharp) ship with the package', () => {
  for (const l of ['ts', 'js'] as Lang[]) assert.equal(getAdapter(l).shimTemplate(spec({ lang: l })).path, '');
  for (const l of ['python', 'java', 'csharp'] as Lang[]) {
    const t = getAdapter(l).shimTemplate(spec({ lang: l }));
    assert.match(t.path, /^\.truthgate\/shims\//);
    assert.match(t.source, /truthgate shim/);
  }
});

test('go template: module import path, exported function map, per-spec path', () => {
  const root = resolve('fixtures/go');
  const t = goTemplate(spec({ lang: 'go', target: 'calc/calc.go::Total' }), root);
  assert.equal(t.path, 'truthgate_shim/a_b_c/main.go');
  assert.match(t.source, /target "truthgate\.local\/fixture\/calc"/);
  assert.match(t.source, /"Total": target\.Total/);
  const seq = goTemplate(spec({ lang: 'go', kind: 'sequence', target: 'calc/stock.go::Stock', ops: [] }), root);
  assert.match(seq.source, /return &target\.Stock\{\}/);
});

test('rust template: crate name, module path, typed args', () => {
  const root = resolve('fixtures/rust');
  const t = rustTemplate(spec({ lang: 'rust', target: 'src/lib.rs::total', inputs: { xs: 'list<int[0,9]>', d: 'decimal[0,1,2]' } }), root);
  assert.equal(t.path, 'examples/truthgate_a_b_c.rs');
  assert.match(t.source, /use fixture as target;/);
  assert.match(t.source, /target::total\(arg::<Vec<i64>>\(a, 0\), arg::<f64>\(a, 1\)\)/);
  const seq = rustTemplate(
    spec({ lang: 'rust', kind: 'sequence', target: 'src/stock.rs::Stock', ops: [{ name: 'add', inputs: { n: 'int[1,5]' } }] }),
    root,
  );
  assert.match(seq.source, /use fixture::stock as target;/);
  assert.match(seq.source, /"add" => o\.as_mut\(\)\.unwrap\(\)\.add\(arg::<i64>\(a, 0\)\)\.tj\(\)/);
});

test('go/rust without a saved shim -> setup error telling the user what to run', async () => {
  for (const l of ['go', 'rust'] as Lang[]) {
    const s = spec({ id: 'not.saved', lang: l, target: l === 'go' ? 'calc/calc.go::Total' : 'src/lib.rs::total' });
    await assert.rejects(getAdapter(l).open(s, resolve(`fixtures/${l}`)), /shim missing: run `npx truthgate shim not\.saved`/);
  }
});
