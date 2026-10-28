import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { Spec } from '../../src/contract.ts';
import { harness, runHypothesis, strategy } from '../../src/runner/hypothesis.ts';

const root = resolve('fixtures/python');
const spec = (fn: string): Spec => ({
  id: `h.${fn}`,
  target: `src/totals.py::${fn}`,
  lang: 'python',
  kind: 'function',
  inputs: { xs: 'list<int[-1000,1000]>' },
  requires: [],
  ensures: [{ name: 'sum', expr: 'out == sum(xs)' }],
  file: 'x.yaml',
});

test('strategy maps every TypeSpec', () => {
  assert.equal(strategy({ t: 'int', min: -1, max: 3 }), 'st.integers(-1, 3)');
  assert.equal(strategy({ t: 'decimal', min: 0, max: 1, places: 2 }), 'st.integers(0, 100).map(lambda n: n / 100)');
  assert.equal(strategy({ t: 'decimal', min: 0, max: 5, places: 0 }), 'st.integers(0, 5)');
  assert.equal(strategy({ t: 'list', of: { t: 'bool' }, max: 4 }), 'st.lists(st.booleans(), max_size=4)');
  assert.equal(strategy({ t: 'record', fields: { a: { t: 'str', max: 3 } } }), 'st.fixed_dictionaries({"a": st.text(max_size=3)})');
  assert.equal(strategy({ t: 'oneof', values: ['x', null] }), 'st.sampled_from(json.loads("[\\"x\\",null]"))');
});

test('harness embeds seed, runs, target and the Python form of each property', () => {
  const src = harness(spec('total'), root, { seed: 7, runs: 33 });
  assert.match(src, /@seed\(7\)/);
  assert.match(src, /max_examples=33/);
  assert.match(src, /"src\/totals.py"/);
  assert.match(src, /_eq\(_var\(env, "out"\), _sum\(_var\(env, "xs"\)\)\)/);
});

test('runHypothesis: verdicts when Hypothesis is importable, else a setup reason (shim fallback)', async () => {
  const opts = { seed: 42, runs: 50, deadline: Date.now() + 60_000, config: { python: { native: true } } as never };
  const ok = await runHypothesis(spec('total'), root, opts);
  if (typeof ok === 'string') {
    assert.match(ok, /hypothesis/i);
    return;
  }
  assert.equal(ok[0]!.kind, 'TESTED');
  const bad = await runHypothesis(spec('total_buggy'), root, opts);
  assert.ok(typeof bad !== 'string');
  assert.equal(bad[0]!.kind, 'FALSIFIED');
});

test('runHypothesis (when importable): TypeError -> crash, wrong-typed out -> FALSIFIED, Rejected/ValueError skipped', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-hyp-test-'));
  writeFileSync(
    join(dir, 'h.py'),
    'class Rejected(Exception):\n    pass\ndef typo(x):\n    return None + 1 if x > 6 else x * 2\ndef null_above(x):\n    return None if x > 6 else x * 2\ndef refuses(x):\n    if x > 8:\n        raise Rejected("no")\n    if x > 6:\n        raise ValueError("no")\n    return x * 2\n',
  );
  const s = (fn: string): Spec => ({ ...spec(fn), target: `h.py::${fn}`, inputs: { x: 'int[0,12]' }, ensures: [{ name: 'p', expr: 'out == x * 2 or out > x' }] });
  const opts = { seed: 42, runs: 100, deadline: Date.now() + 60_000, config: { python: { native: true } } as never };
  const typo = await runHypothesis(s('typo'), dir, opts);
  if (typeof typo === 'string') return t.skip(`Hypothesis not importable: ${typo}`);
  assert.equal(typo[0]!.kind, 'FALSIFIED');
  assert.match(typo[0]!.detail, /TypeError/);
  const nul = await runHypothesis(s('null_above'), dir, opts);
  assert.ok(typeof nul !== 'string' && nul[0]!.kind === 'FALSIFIED' && /expression error/.test(nul[0]!.detail));
  const ref = await runHypothesis(s('refuses'), dir, opts);
  assert.ok(typeof ref !== 'string' && ref[0]!.kind === 'TESTED');
});
