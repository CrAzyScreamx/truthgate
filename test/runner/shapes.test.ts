// Targets that plain type stripping could not load, and target shapes that need observe / init / iterable outputs.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { Config, Spec } from '../../src/contract.ts';
import { parseSpec } from '../../src/core/spec.ts';
import { runSpec } from '../../src/runner/index.ts';

const project = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'tg-shapes-'));
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  return root;
};
const opts = { seed: 42, runs: 60, deadline: Date.now() + 120_000, config: { python: { native: false } } as Config };
const spec = (yaml: string) => parseSpec(yaml, '.truthgate/specs/x.yaml');
const kinds = async (s: Spec, root: string) => (await runSpec(s, root, opts)).map((v) => `${v.property}:${v.kind}${v.kind === 'TESTED' ? '' : ' ' + v.detail}`);

// A NestJS-shaped CommonJS project: decorators, parameter properties, extensionless imports, a tsconfig `paths` alias.
const nest = project({
  'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'commonjs', experimentalDecorators: true, emitDecoratorMetadata: true, baseUrl: '.', paths: { '@app/*': ['src/*'] } } }),
  'package.json': '{ "name": "nest-like" }\n',
  'src/core/rate.ts': 'export const RATE = 2;\n',
  'src/util.ts': 'export function clamp(x: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, x)); }\n',
  'src/pricing.service.ts': `import { RATE } from '@app/core/rate';
import { clamp } from './util';
function Injectable(): ClassDecorator { return () => {}; }
@Injectable()
export class PricingService {
  private total = 0;
  constructor(private readonly cap: number = 10) {}
  add(n: number) { this.total = clamp(this.total + n * RATE, 0, this.cap); }
  state() { return { total: this.total, cap: this.cap }; }
}
export function price(qty: number): number { return clamp(qty * RATE, 0, 100); }
`,
  'src/broken.ts': "import { nothing } from './does-not-exist';\nexport const f = (x: number) => x + nothing;\n",
});

test('tsx loads NestJS-style TS: decorators, parameter properties, extensionless imports, paths aliases, CommonJS', async () => {
  const fn = spec('id: p\ntarget: src/pricing.service.ts::price\nlang: ts\ninputs: { qty: "int[0,80]" }\nensures:\n  - { name: capped, expr: "out == min(qty * 2, 100)" }\n');
  assert.deepEqual(await kinds(fn, nest), ['capped:TESTED']);
  const seq = spec('id: s\ntarget: src/pricing.service.ts::PricingService\nlang: ts\nkind: sequence\ninit: [7]\nops:\n  - { name: add, inputs: { n: "int[0,5]" } }\ninvariant:\n  - { name: within_cap, expr: "state.total <= state.cap and state.cap == 7" }\n');
  assert.deepEqual(await kinds(seq, nest), ['within_cap:TESTED']);
});

test('a target that cannot load is UNVERIFIED with a one-line reason', async () => {
  const s = spec('id: b\ntarget: src/broken.ts::f\nlang: ts\ninputs: { x: "int[0,1]" }\nensures:\n  - { name: p, expr: "out == x" }\n');
  const [v] = await runSpec(s, nest, opts);
  assert.equal(v!.kind, 'UNVERIFIED');
  assert.match(v!.detail, /cannot load src\/broken\.ts: .*does-not-exist/);
});

const ts = project({
  'm.ts': `export function addUnique(xs: number[], x: number): void { if (!xs.includes(x)) xs.push(x); }
export function addUniqueBuggy(xs: number[], x: number): void { xs.push(x); }
export function* pairs(xs: number[]) { for (let i = 0; i + 1 < xs.length; i += 2) yield [xs[i], xs[i + 1]]; }
export const asSet = (xs: number[]) => new Set(xs);
`,
});

test('observe: a void function that mutates its argument is checked through that argument', async () => {
  const s = (fn: string) => spec(`id: u\ntarget: m.ts::${fn}\nlang: ts\ninputs: { xs: "list<int[0,3]>[6]", x: "int[0,3]" }\nrequires: ["unique(xs)"]\nobserve: xs\nensures:\n  - { name: once, expr: "count(out, x) == 1 and unique(out)" }\n`);
  assert.deepEqual(await kinds(s('addUnique'), ts), ['once:TESTED']);
  const [bad] = await runSpec(s('addUniqueBuggy'), ts, opts);
  assert.equal(bad!.kind, 'FALSIFIED', bad!.detail);
});

test('generators and Sets come back as lists', async () => {
  const g = spec('id: g\ntarget: m.ts::pairs\nlang: ts\ninputs: { xs: "list<int[0,9]>[8]" }\nensures:\n  - { name: n, expr: "len(out) == (len(xs) - len(xs) % 2) / 2 and all(p in out: len(p) == 2)" }\n');
  assert.deepEqual(await kinds(g, ts), ['n:TESTED']);
  const st = spec('id: st\ntarget: m.ts::asSet\nlang: ts\ninputs: { xs: "list<int[0,3]>[6]" }\nensures:\n  - { name: u, expr: "unique(out) and all(x in xs: count(out, x) == 1)" }\n');
  assert.deepEqual(await kinds(st, ts), ['u:TESTED']);
});

test('python shim: observe, init and generators', async () => {
  const py = project({
    'p.py': `def add_unique(xs, x):
    if x not in xs:
        xs.append(x)

def pairs(xs):
    for i in range(0, len(xs) - 1, 2):
        yield [xs[i], xs[i + 1]]

class Box:
    def __init__(self, cap):
        self.cap, self.items = cap, []

    def put(self, x):
        if len(self.items) >= self.cap:
            raise ValueError("full")
        self.items.append(x)
`,
  });
  const o = spec('id: o\ntarget: p.py::add_unique\nlang: python\ninputs: { xs: "list<int[0,3]>[6]", x: "int[0,3]" }\nrequires: ["unique(xs)"]\nobserve: xs\nensures:\n  - { name: once, expr: "count(out, x) == 1" }\n');
  assert.deepEqual(await kinds(o, py), ['once:TESTED']);
  const g = spec('id: g\ntarget: p.py::pairs\nlang: python\ninputs: { xs: "list<int[0,9]>[8]" }\nensures:\n  - { name: n, expr: "len(out) == (len(xs) - len(xs) % 2) / 2" }\n');
  assert.deepEqual(await kinds(g, py), ['n:TESTED']);
  const b = spec('id: b\ntarget: p.py::Box\nlang: python\nkind: sequence\ninit: [2]\nops:\n  - { name: put, inputs: { x: "int[0,9]" } }\ninvariant:\n  - { name: cap, expr: "len(state.items) <= 2 and state.cap == 2" }\n');
  assert.deepEqual(await kinds(b, py), ['cap:TESTED']);
});

test('observe/init are validated: function vs sequence, a real input, generic languages only', () => {
  const base = 'id: v\ntarget: a.ts::f\nlang: ts\ninputs: { xs: "list<int[0,1]>" }\nensures:\n  - { name: p, expr: "true" }\n';
  assert.throws(() => spec(base + 'observe: ys\n'), /observe: must name one of the inputs \(xs\)/);
  assert.throws(() => spec(base.replace('lang: ts', 'lang: go').replace('a.ts', 'a.go') + 'observe: xs\n'), /observe: supported for ts, js and python only; for go, wrap the target/);
  assert.throws(() => spec(base + 'init: [1]\n'), /init: is for sequence specs/);
  const seq = 'id: q\ntarget: a.ts::Q\nlang: ts\nkind: sequence\nops:\n  - { name: push, inputs: { x: "int[0,1]" } }\ninvariant:\n  - { name: p, expr: "true" }\n';
  assert.throws(() => spec(seq + 'init: 3\n'), /init: expected a list/);
  assert.throws(() => spec(seq + 'observe: x\n'), /observe: is for function specs/);
  assert.deepEqual(spec(seq + 'init: [3, "x"]\n').init, [3, 'x']);
});
