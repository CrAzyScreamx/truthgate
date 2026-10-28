import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunOptions, RunReport, Spec, Verdict } from '../../src/contract.ts';
import { weakSpecCheck } from '../../src/core/weak.ts';
import { verify, LAST_RUN_FILE } from '../../src/core/verify.ts';
import { formatReport } from '../../src/core/report.ts';
import { repo, put } from './helpers.ts';

const fn = (over: Partial<Spec>): Spec => ({
  id: 's', target: 'src/x.py::f', lang: 'python', kind: 'function', inputs: { xs: 'list<int[-50,50]>' }, requires: [], ensures: [], file: 's.yaml', ...over,
});

test('weakSpecCheck flags specs that fakes satisfy', () => {
  const sortSpec = fn({ ensures: [{ name: 'sorted', expr: 'all(i in range(len(out)-1): out[i] <= out[i+1])' }, { name: 'perm', expr: 'perm(out, xs)' }] });
  assert.deepEqual(weakSpecCheck(sortSpec), []);
  const onlySorted = fn({ ensures: [{ name: 'sorted', expr: 'all(i in range(len(out)-1): out[i] <= out[i+1])' }] });
  const [v] = weakSpecCheck(onlySorted);
  assert.equal(v?.kind, 'WEAK_SPEC');
  assert.match(v!.detail, /always returns \[\]/);
  const identity = fn({ inputs: { x: 'int[0,9]' }, ensures: [{ name: 'same', expr: 'out == x' }] });
  assert.match(weakSpecCheck(identity)[0]!.detail, /returns its input "x" unchanged/);
  const abs = fn({ inputs: { x: 'int[-9,9]' }, ensures: [{ name: 'abs', expr: 'out == abs(x)' }] });
  assert.deepEqual(weakSpecCheck(abs), []);
  // requires filters samples: with x >= 0 only, identity satisfies out == abs(x).
  assert.equal(weakSpecCheck({ ...abs, requires: ['x >= 0'] }).length, 1);
  // No usable sample, sequence specs: nothing to judge.
  assert.deepEqual(weakSpecCheck({ ...abs, requires: ['false'] }), []);
  assert.deepEqual(weakSpecCheck(fn({ kind: 'sequence', ensures: [], invariant: [{ name: 'i', expr: 'true' }] })), []);
  // Covers every generator kind without throwing.
  const rich = fn({
    inputs: { r: 'record{a: decimal[0,1,2], b: str[3], c: bool, d: oneof["x", 2]}' },
    ensures: [{ name: 'p', expr: 'out == r' }],
  });
  assert.equal(weakSpecCheck(rich).length, 1);
});

const SPEC = (id: string, target: string, ensures = 'perm(out, xs) and all(i in range(len(out)-1): out[i] <= out[i+1])') =>
  `id: ${id}\ntarget: ${target}\nlang: python\ninputs: { xs: "list<int[0,9]>" }\nensures:\n  - name: p\n    expr: "${ensures}"\n`;

const pyAdapter = {
  lang: 'python' as const,
  available: async () => true as const,
  open: async () => {
    throw new Error('unused');
  },
  shimTemplate: () => ({ path: '', source: '' }),
  testFileGlobs: ['**/test_*.py'],
  skipMarkers: [/@pytest\.mark\.skip/],
  assertPatterns: [/\bassert\b/],
  lineComment: '#',
};

test('verify: selects by changed target, warns, shares the deadline, blocks on FALSIFIED', async () => {
  const root = await repo({
    '.truthgate/specs/a.yaml': SPEC('a', 'src/a.py::f'),
    '.truthgate/specs/b.yaml': SPEC('b', 'src/b.py::f'),
    'src/a.py': '1',
    'src/b.py': '1',
    'src/c.py': '1',
  });
  await put(root, 'src/a.py', '2');
  await put(root, 'src/c.py', '2');
  await put(root, 'tests/test_new.py', 'assert f(1) == 1');
  const calls: [string, RunOptions][] = [];
  const runSpec = async (s: Spec, _r: string, o: RunOptions): Promise<Verdict[]> => {
    calls.push([s.id, o]);
    return [{ specId: s.id, property: 'p', kind: 'FALSIFIED', detail: 'failed', counterexample: { xs: [1, 0] }, durationMs: 1 }];
  };
  const r = await verify(root, { budgetSeconds: 30 }, { runSpec, adapters: [pyAdapter] });
  assert.deepEqual(calls.map((c) => c[0]), ['a']);
  assert.equal(calls[0]![1].runs, 100);
  assert.equal(calls[0]![1].seed, 42);
  assert.ok(Math.abs(calls[0]![1].deadline - (Date.now() + 30000)) < 5000);
  assert.equal(r.blocking, true);
  assert.deepEqual(r.tamper, []);
  assert.ok(r.warnings.some((w) => w === 'src/c.py changed but has no spec: UNVERIFIED (no spec)'));
  assert.ok(!r.warnings.some((w) => w.includes('test_new')));
  assert.ok(r.warnings.some((w) => /spec a is not approved/.test(w)));
  assert.deepEqual(JSON.parse(await readFile(join(root, LAST_RUN_FILE), 'utf8')).verdicts, r.verdicts);

  // --all runs every spec; a zero budget turns unstarted specs into UNVERIFIED (timeout).
  const r2 = await verify(root, { all: true, budgetSeconds: 0 }, { runSpec, adapters: [pyAdapter] });
  assert.deepEqual(r2.verdicts.map((v) => [v.specId, v.kind]), [['a', 'UNVERIFIED'], ['b', 'UNVERIFIED']]);
  assert.match(r2.verdicts[0]!.detail, /timeout/);
  assert.equal(r2.blocking, false);
});

test('verify: runner errors are UNVERIFIED, weak specs reported, tamper blocks, deep runs only with --deep', async () => {
  const root = await repo({ '.truthgate/specs/a.yaml': SPEC('a', 'src/a.py::f', 'len(out) >= 0'), 'src/a.py': '1', 'tests/test_a.py': 'assert 1\nassert 2\n' });
  await put(root, 'src/a.py', '2');
  await put(root, 'tests/test_a.py', 'assert 1\n');
  let deepCalls = 0;
  const deps = {
    adapters: [pyAdapter],
    runSpec: async () => {
      throw new Error('shim exploded');
    },
    runDeep: async () => {
      deepCalls++;
      return { proofs: [], mutation: { caught: 1, total: 2, survivors: [{ file: 'src/a.py', line: 1, desc: '< -> <=' }], durationMs: 1 } };
    },
  };
  const r = await verify(root, {}, deps);
  assert.deepEqual(r.verdicts.map((v) => v.kind), ['WEAK_SPEC', 'UNVERIFIED']);
  assert.match(r.verdicts[1]!.detail, /runner error: shim exploded/);
  assert.deepEqual(r.tamper.map((t) => t.rule), ['assert-removed']);
  assert.equal(r.blocking, true);
  assert.equal(deepCalls, 0);
  assert.equal(r.deep, undefined);
  const d = await verify(root, { deep: true }, deps);
  assert.equal(deepCalls, 1);
  assert.equal(d.deep?.mutation?.caught, 1);
});

test('verify outside git runs everything and warns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tg-nogit-'));
  await put(root, '.truthgate/specs/a.yaml', SPEC('a', 'src/a.py::f'));
  const r = await verify(root, {}, { adapters: [pyAdapter], runSpec: async (s) => [{ specId: s.id, kind: 'TESTED', detail: 'ok', durationMs: 0 }] });
  assert.deepEqual(r.verdicts.map((v) => v.kind), ['TESTED']);
  assert.match(r.warnings[0]!, /not a git repository/);
});

const base: RunReport = { verdicts: [], tamper: [], warnings: [], changedFiles: [], blocking: false, durationMs: 1234 };

test('formatReport', () => {
  assert.match(formatReport(base), /No specs ran[\s\S]*no verdicts · 0 tamper findings · 0 warnings · 1\.2s\nOK: nothing blocking\./);
  const text = formatReport({
    ...base,
    blocking: true,
    verdicts: [
      { specId: 'sort', property: 'sorted', kind: 'TESTED', detail: '100 runs, 0 failures', durationMs: 1 },
      { specId: 'sort', property: 'perm', kind: 'FALSIFIED', detail: 'perm failed', counterexample: { xs: [2, 1] }, seed: 42, durationMs: 1 },
      { specId: 'w', kind: 'WEAK_SPEC', detail: 'weak', durationMs: 1 },
    ],
    tamper: [{ file: 't.py', line: 3, rule: 'skip-added', detail: 'new skip' }],
    warnings: ['x.py changed but has no spec'],
    deep: { proofs: [{ specId: 'sort', kind: 'PROVEN_MODEL_ONLY', detail: 'rocq', durationMs: 1 }], mutation: { caught: 2, total: 3, survivors: [{ file: 'x.py', line: 4, desc: '+ -> -' }], durationMs: 1 } },
  });
  const lines = text.split('\n');
  assert.match(lines[0]!, /^TESTED\s+sort \/ sorted\s+100 runs/);
  assert.match(lines[1]!, /^FALSIFIED\s+sort \/ perm/);
  assert.match(lines[2]!, /^\s+counterexample: \{"xs":\[2,1\]\} \(seed 42\)$/);
  assert.match(text, /WEAK SPEC\s+w\s+weak/);
  assert.match(text, /PROVEN \(model only\)\s+sort/);
  assert.match(text, /TAMPER\s+skip-added  t\.py:3  new skip/);
  assert.match(text, /caught 2\/3[\s\S]*survived: x\.py:4 \+ -> -/);
  assert.match(text, /WARN\s+x\.py changed/);
  assert.match(text, /1 PROVEN \(model only\), 1 FALSIFIED, 1 TESTED, 1 WEAK SPEC · 1 tamper finding · 1 warning/);
  assert.match(text, /BLOCKING: 1 FALSIFIED verdict and 1 tamper finding\./);
});

test('verify advances the baseline only on a clean, fully verified run with a clean tree', async () => {
  const { readBaseline } = await import('../../src/core/baseline.ts');
  const { execFileSync } = await import('node:child_process');
  const root = await repo({ '.truthgate/specs/a.yaml': SPEC('a', 'src/a.py::f'), 'src/a.py': '1', '.gitignore': '.truthgate/last-run.json\n' });
  const ok = async (s: Spec): Promise<Verdict[]> => [{ specId: s.id, property: 'p', kind: 'TESTED', detail: 'ok', durationMs: 0 }];
  const unverified = async (s: Spec): Promise<Verdict[]> => [{ specId: s.id, kind: 'UNVERIFIED', detail: 'shim error', durationMs: 0 }];
  const { commitOf } = await import('../../src/core/diff.ts');
  const first = await commitOf(root, 'HEAD');
  const r0 = await verify(root, {}, { runSpec: ok, adapters: [pyAdapter] });
  assert.ok(r0.warnings.some((w) => /no truthgate baseline recorded/.test(w)));
  assert.deepEqual(await readBaseline(root), { commit: first, source: 'clean-run' }); // clean tree, nothing failed
  await put(root, 'src/a.py', '2');
  await verify(root, {}, { runSpec: ok, adapters: [pyAdapter] }); // dirty tree: no advance
  execFileSync('git', ['commit', '-qam', 'two'], { cwd: root });
  assert.equal((await readBaseline(root)).commit, first);
  await verify(root, {}, { runSpec: unverified, adapters: [pyAdapter] }); // UNVERIFIED: no advance
  assert.equal((await readBaseline(root)).commit, first);
  assert.equal((await verify(root, {}, { runSpec: ok, adapters: [pyAdapter] })).blocking, false);
  assert.deepEqual(await readBaseline(root), { commit: await commitOf(root, 'HEAD'), source: 'clean-run' });
  // Once advanced, the warning goes away and the committed target no longer counts as changed.
  const r2 = await verify(root, {}, { runSpec: ok, adapters: [pyAdapter] });
  assert.ok(!r2.warnings.some((w) => /no truthgate baseline/.test(w)));
  assert.deepEqual(r2.verdicts, []);
});
