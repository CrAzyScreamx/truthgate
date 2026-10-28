import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import fc from 'fast-check';
import type { Config, Spec } from '../../src/contract.ts';
import { arb, runSpec } from '../../src/runner/index.ts';

const root = mkdtempSync(join(tmpdir(), 'tg-runner-test-'));
writeFileSync(
  join(root, 'm.ts'),
  `export const dbl = (x: number) => x * 2;
export const off = (x: number) => (x > 7 ? x * 2 + 1 : x * 2);
export const boom = (x: number) => { if (x > 3) throw new Error('kaboom'); return x * 2; };
export const picky = (x: number) => { if (x % 2) throw new RangeError('odd'); return x * 2; };
export const nul = (_x: number) => null;
export const sortInPlace = (xs: number[]) => xs.sort((a, b) => a - b);
export class Counter {
  n = 0;
  inc(k: number) { this.n += k; }
  dec(k: number) { if (k > this.n) throw new RangeError('below zero'); this.n -= k; }
}
export class Leaky {
  n = 0;
  inc(k: number) { this.n += k; }
  dec(k: number) { if (k > this.n + 1) throw new RangeError('below zero'); this.n -= k; }
}
`,
);

const config = { python: { native: false } } as Config;
const opts = (over: object = {}) => ({ seed: 42, runs: 100, deadline: Date.now() + 30_000, config, ...over });
const fnSpec = (fn: string, ensures: string, extra: Partial<Spec> = {}): Spec => ({
  id: `t.${fn}`,
  target: `m.ts::${fn}`,
  lang: 'ts',
  kind: 'function',
  inputs: { x: 'int[0,10]' },
  requires: [],
  ensures: [{ name: 'p', expr: ensures }],
  file: 'x.yaml',
  ...extra,
});
const seqSpec = (cls: string): Spec => ({
  id: `s.${cls}`,
  target: `m.ts::${cls}`,
  lang: 'ts',
  kind: 'sequence',
  inputs: {},
  requires: [],
  ensures: [],
  ops: [
    { name: 'inc', inputs: { k: 'int[1,3]' } },
    { name: 'dec', inputs: { k: 'int[1,3]' } },
  ],
  invariant: [{ name: 'nonneg', expr: 'state.n >= 0' }],
  file: 'x.yaml',
});
const one = async (s: Spec, o = opts()) => {
  const vs = await runSpec(s, root, o);
  assert.equal(vs.length, 1);
  return vs[0]!;
};

test('arb: decimals are exact to places and within bounds', () => {
  fc.assert(
    fc.property(arb({ t: 'decimal', min: -1, max: 2.5, places: 2 }), (v) => {
      const n = v as number;
      return n >= -1 && n <= 2.5 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-9;
    }),
  );
  fc.assert(fc.property(arb({ t: 'list', of: { t: 'oneof', values: ['a', 1] }, max: 3 }), (v) => (v as unknown[]).length <= 3));
});

test('TESTED states N and the 3/N bound', async () => {
  const v = await one(fnSpec('dbl', 'out == x * 2'));
  assert.equal(v.kind, 'TESTED');
  assert.equal(v.detail, '100 runs, 0 failures: failure rate < 3/100 (95%)');
  assert.equal(v.runs, 100);
  assert.equal(v.property, 'p');
});

test('spec.runs overrides opts.runs', async () => {
  const v = await one(fnSpec('dbl', 'out == x * 2', { runs: 25 }));
  assert.equal(v.detail, '25 runs, 0 failures: failure rate < 3/25 (95%)');
});

test('FALSIFIED with the shrunk counterexample and seed', async () => {
  const v = await one(fnSpec('off', 'out == x * 2'));
  assert.equal(v.kind, 'FALSIFIED');
  assert.deepEqual(v.counterexample, { x: 8 });
  assert.equal(v.seed, 42);
  assert.match(v.detail, /out = 17/);
});

test('crash is FALSIFIED unless allowCrash', async () => {
  const v = await one(fnSpec('boom', 'out == x * 2'));
  assert.equal(v.kind, 'FALSIFIED');
  assert.deepEqual(v.counterexample, { x: 4 });
  assert.match(v.detail, /kaboom/);
  assert.equal((await one(fnSpec('boom', 'out == x * 2', { allowCrash: true, inputs: { x: 'int[0,6]' } }))).kind, 'TESTED');
});

test('rejected inputs are skipped; requires discards; >50% discarded -> UNVERIFIED', async () => {
  const half = await one(fnSpec('picky', 'out == x * 2', { inputs: { x: 'int[0,1000]' } }));
  assert.equal(half.kind, 'TESTED', half.detail);
  assert.match(half.detail, /inputs discarded/);
  const strict = await one(fnSpec('dbl', 'out == x * 2', { requires: ['x == 3'] }));
  assert.equal(strict.kind, 'UNVERIFIED');
  assert.match(strict.detail, /preconditions too strict/);
});

test('expression type errors are UNVERIFIED, not FALSIFIED', async () => {
  const v = await one(fnSpec('nul', 'out > 1'));
  assert.equal(v.kind, 'UNVERIFIED');
  assert.match(v.detail, /expression error/);
  const nb = await one(fnSpec('dbl', 'out + 1'));
  assert.equal(nb.kind, 'UNVERIFIED');
  assert.match(nb.detail, /expected bool/);
  const parse = await one(fnSpec('dbl', 'out ==='));
  assert.equal(parse.kind, 'UNVERIFIED');
  assert.equal(parse.property, undefined);
});

test('inputs are cloned: in-place mutation cannot fake perm()', async () => {
  const v = await one(fnSpec('sortInPlace', 'perm(out, xs) and all(i in range(len(out) - 1): out[i] <= out[i + 1])', { inputs: { xs: 'list<int[-5,5]>' } }));
  assert.equal(v.kind, 'TESTED', v.detail);
});

test('deadline already passed -> UNVERIFIED timeout', async () => {
  const v = await one(fnSpec('dbl', 'out == x * 2'), opts({ deadline: Date.now() - 1 }));
  assert.equal(v.kind, 'UNVERIFIED');
  assert.match(v.detail, /timeout/);
});

test('missing export -> one spec-level UNVERIFIED', async () => {
  const v = await one(fnSpec('nope', 'out == 1'));
  assert.equal(v.kind, 'UNVERIFIED');
  assert.equal(v.property, undefined);
  assert.match(v.detail, /no exported function/);
});

test('sequence: correct guard -> TESTED, planted guard bug -> FALSIFIED with a shrunk op list', async () => {
  assert.equal((await one(seqSpec('Counter'))).kind, 'TESTED');
  const v = await one(seqSpec('Leaky'));
  assert.equal(v.kind, 'FALSIFIED');
  const steps = v.counterexample as { op: string; input: { k: number } }[];
  assert.deepEqual(steps, [{ op: 'dec', input: { k: 1 } }]);
  assert.equal(steps.at(-1)!.op, 'dec');
  assert.match(v.detail, /state = \{"n":-1\}/);
});
