import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import fc from 'fast-check';
import type { Config, Spec } from '../../src/contract.ts';
import { arb, runSpec } from '../../src/runner/index.ts';
import { exec } from '../../src/runner/proc.ts';

const root = mkdtempSync(join(tmpdir(), 'tg-runner-test-'));
writeFileSync(
  join(root, 'm.ts'),
  `export const dbl = (x: number) => x * 2;
export const off = (x: number) => (x > 7 ? x * 2 + 1 : x * 2);
export const boom = (x: number) => { if (x > 3) throw new Error('kaboom'); return x * 2; };
export const picky = (x: number) => { if (x % 2) throw new RangeError('odd'); return x * 2; };
export const nul = (_x: number) => null;
export const nullAbove = (x: number) => (x > 6 ? null : x * 2);
export const typo = (x: number) => (x > 6 ? (null as any).v : x * 2);
export const refuses = (x: number) => { if (x > 6) { const e = new Error('no'); e.name = 'Rejected'; throw e; } return x * 2; };
export const spin = (_x: number) => { for (;;) {} };
export const deep = (n: number): number => (n > 7 ? deep(n) : n);
let failed = false;
export const dieAfterFail = (x: number) => { if (failed) process.exit(1); if (x >= 5) { failed = true; return -1; } return x * 2; };
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
export class Nully {
  n: number | null = 0;
  inc(k: number) { this.n = k === 3 ? null : (this.n ?? 0) + k; }
  dec(_k: number) {}
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

test('TypeError is a crash; RangeError and errors named Rejected are rejected', async () => {
  const v = await one(fnSpec('typo', 'out == x * 2'));
  assert.equal(v.kind, 'FALSIFIED', v.detail);
  assert.deepEqual(v.counterexample, { x: 7 });
  assert.match(v.detail, /TypeError/);
  const r = await one(fnSpec('refuses', 'out == x * 2', { inputs: { x: 'int[0,12]' } }));
  assert.equal(r.kind, 'TESTED', r.detail);
  assert.match(r.detail, /inputs discarded/);
});

test('JS stack overflow (a RangeError) is a crash, not a rejection', async () => {
  const v = await one(fnSpec('deep', 'out == x'));
  assert.equal(v.kind, 'FALSIFIED', v.detail);
  assert.deepEqual(v.counterexample, { x: 8 });
  assert.match(v.detail, /call stack/i);
});

test('ensures ExprError (wrong-typed out) is FALSIFIED; requires ExprError is UNVERIFIED', async () => {
  const v = await one(fnSpec('nullAbove', 'out == x * 2 or out > x'));
  assert.equal(v.kind, 'FALSIFIED', v.detail);
  assert.deepEqual(v.counterexample, { x: 7 });
  assert.match(v.detail, /expression error/);
  const nb = await one(fnSpec('dbl', 'out + 1'));
  assert.equal(nb.kind, 'FALSIFIED');
  assert.match(nb.detail, /expected bool/);
  const req = await one(fnSpec('dbl', 'out == x * 2', { requires: ['x > "a"'] }));
  assert.equal(req.kind, 'UNVERIFIED');
  assert.match(req.detail, /expression error/);
  const parse = await one(fnSpec('dbl', 'out ==='));
  assert.equal(parse.kind, 'UNVERIFIED');
  assert.equal(parse.property, undefined);
});

test('inputs are cloned: in-place mutation cannot fake perm()', async () => {
  const v = await one(fnSpec('sortInPlace', 'perm(out, xs) and all(i in range(len(out) - 1): out[i] <= out[i + 1])', { inputs: { xs: 'list<int[-5,5]>' } }));
  assert.equal(v.kind, 'TESTED', v.detail);
});

test('a hung JS target is killed at the deadline -> UNVERIFIED timeout', async () => {
  const t0 = Date.now();
  const v = await one(fnSpec('spin', 'out == 1'), opts({ deadline: Date.now() + 1500 }));
  assert.equal(v.kind, 'UNVERIFIED');
  assert.match(v.detail, /timeout/);
  assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms`);
});

test('a counterexample found before the shim dies is kept (fail before abort)', async () => {
  const v = await one(fnSpec('dieAfterFail', 'out == x * 2'));
  assert.equal(v.kind, 'FALSIFIED', v.detail);
  assert.ok((v.counterexample as { x: number }).x >= 5);
});

test('zero completed runs is never TESTED', async () => {
  const v = await one(fnSpec('dbl', 'out == x * 2'), opts({ runs: 0 }));
  assert.equal(v.kind, 'UNVERIFIED');
  assert.match(v.detail, /no inputs were run/);
});

test('deadline already passed -> UNVERIFIED timeout', async () => {
  const v = await one(fnSpec('dbl', 'out == x * 2'), opts({ deadline: Date.now() - 1 }));
  assert.equal(v.kind, 'UNVERIFIED');
  assert.match(v.detail, /timeout/);
});

test('missing export -> UNVERIFIED shim error', async () => {
  const v = await one(fnSpec('nope', 'out == 1'));
  assert.equal(v.kind, 'UNVERIFIED');
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

test('sequence: invariant ExprError on the state is FALSIFIED', async () => {
  const v = await one(seqSpec('Nully'));
  assert.equal(v.kind, 'FALSIFIED', v.detail);
  assert.deepEqual(v.counterexample, [{ op: 'inc', input: { k: 3 } }]);
  assert.match(v.detail, /expression error/);
});

test('python shim: TypeError is a crash, ValueError and Rejected are rejected', async () => {
  writeFileSync(
    join(root, 'p.py'),
    `class Rejected(Exception):
    pass

def typo(x):
    return None + 1 if x > 6 else x * 2

def refuses(x):
    if x > 8:
        raise Rejected("no")
    if x > 6:
        raise ValueError("no")
    return x * 2
`,
  );
  const py = (fn: string) => fnSpec(fn, 'out == x * 2', { lang: 'python', target: `p.py::${fn}`, inputs: { x: 'int[0,12]' } });
  const v = await one(py('typo'));
  assert.equal(v.kind, 'FALSIFIED', v.detail);
  assert.match(v.detail, /TypeError/);
  const r = await one(py('refuses'));
  assert.equal(r.kind, 'TESTED', r.detail);
  assert.match(r.detail, /inputs discarded/);
});

test('uv project: a hung python target behind `uv run` leaves no process behind (R2-N1)', { timeout: 120_000 }, async (t) => {
  const uvRoot = mkdtempSync(join(tmpdir(), 'tg-uv-test-'));
  writeFileSync(join(uvRoot, 'pyproject.toml'), '[project]\nname = "uvt"\nversion = "0.1.0"\nrequires-python = ">=3.8"\ndependencies = []\n');
  const pidFile = join(uvRoot, 'pid.txt').replaceAll('\\', '/');
  writeFileSync(join(uvRoot, 'm.py'), `import os\ndef spin(n):\n    open("${pidFile}", "w").write(str(os.getpid()))\n    while True:\n        pass\n`);
  const lock = await exec(['uv', 'lock', '-q'], { cwd: uvRoot, timeoutMs: 60_000 });
  if (lock.code !== 0) return t.skip(`uv unavailable: ${lock.error ?? lock.stderr.trim()}`);
  const [v] = await runSpec(fnSpec('spin', 'out == x', { lang: 'python', target: 'm.py::spin' }), uvRoot, opts({ deadline: Date.now() + 3000 }));
  assert.equal(v!.kind, 'UNVERIFIED');
  assert.match(v!.detail, /timeout/);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 120 && alive(); i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal(alive(), false, `python ${pid} under uv run still running`);
});
