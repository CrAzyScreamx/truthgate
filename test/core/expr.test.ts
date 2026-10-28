import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { expr, ExprError, PY_HELPERS } from '../../src/core/expr.ts';

const ev = (src: string, env: Record<string, unknown> = {}) => expr.evaluate(expr.parse(src), env);

test('parses precedence and associativity', () => {
  assert.equal(ev('1 + 2 * 3'), 7);
  assert.equal(ev('(1 + 2) * 3'), 9);
  assert.equal(ev('10 - 3 - 2'), 5);
  assert.equal(ev('-2 * -3'), 6);
  assert.equal(ev('not true or true'), true);
  assert.equal(ev('true or false and false'), true);
  assert.equal(ev('false implies false implies false'), true); // right-assoc: F -> (F -> F)
  assert.equal(ev('1 < 2 and 2 <= 2 and 3 > 2 and 3 >= 3 and 1 != 2'), true);
});

test('evaluates the plan examples', () => {
  const env = { xs: [3, 1, 2], out: [1, 2, 3] };
  assert.equal(ev('all(i in range(len(out)-1): out[i] <= out[i+1])', env), true);
  assert.equal(ev('perm(out, xs)', env), true);
  assert.equal(ev('perm(out, [1, 2, 2])', env), false);
  assert.equal(ev('any(x in xs: x > 2)', env), true);
  assert.equal(ev('all(x in []: false)'), true);
});

test('field, index, literals and helpers', () => {
  const env = { r: { a: { b: [10, 20] } }, s: 'héllo😀' };
  assert.equal(ev('r.a.b[1]', env), 20);
  assert.equal(ev('r["a"].b[0]', env), 10);
  assert.equal(ev('len(s)', env), 6);
  assert.equal(ev('s[5]', env), '😀');
  assert.deepEqual(ev('{k: 1, "two words": [true, null]}'), Object.assign(Object.create(null), { k: 1, 'two words': [true, null] }));
  assert.equal(ev('{a: 1, b: [1, {c: 2}]} == {b: [1, {c: 2}], a: 1}'), true);
  assert.equal(ev('[1, true] == [1, 1]'), false);
  assert.equal(ev('null == null'), true);
  assert.equal(ev("'a\\'b\\n\\u0041' == \"a'b\\nA\""), true);
  assert.equal(ev('sum([1, 2.5])'), 3.5);
  assert.equal(ev('sum([])'), 0);
  assert.equal(ev('min([3, 1, 2]) + max(4, 9, 2)'), 10);
  assert.equal(ev('min("b", "a")'), 'a');
  assert.equal(ev('abs(-4)'), 4);
  assert.equal(ev('round(2.5)'), 3);
  assert.equal(ev('round(-2.5)'), -3);
  assert.equal(ev('round(1.2345, 2)'), 1.23);
  assert.deepEqual(ev('sorted([3, 1, 2])'), [1, 2, 3]);
  assert.equal(ev('unique([1, 2, 3]) and not unique([1, [2], [2]])'), true);
  assert.equal(ev('count([1, 2, 1], 1)'), 2);
  assert.deepEqual(ev('range(3)'), [0, 1, 2]);
  assert.deepEqual(ev('range(2, 4)'), [2, 3]);
  assert.deepEqual(ev('range(4, 2)'), []);
  assert.deepEqual(ev('keys({b: 1, a: 2})'), ['a', 'b']);
  assert.deepEqual(ev('values({b: 1, a: 2})'), [2, 1]);
  assert.equal(ev('7 % 3 == 1 and -7 % 3 == 2 and 7 % -3 == -2'), true);
  assert.equal(ev('7 / 2'), 3.5);
  assert.deepEqual(ev('[1] + [2]'), [1, 2]);
  assert.equal(ev('"a" + "b"'), 'ab');
  assert.equal(ev('"B" < "a"'), true);
});

test('short-circuits and/or/implies/quantifiers', () => {
  assert.equal(ev('false and missing'), false);
  assert.equal(ev('true or missing'), true);
  assert.equal(ev('false implies missing'), true);
  assert.equal(ev('len(xs) > 0 and xs[0] == 1', { xs: [] }), false);
  assert.equal(ev('all(x in [1, "a"]: x == 2)'), false);
});

test('quantifier variables shadow outer ones', () => {
  assert.equal(ev('all(x in [1, 2]: any(x in [5]: x == 5)) and x == 9', { x: 9 }), true);
});

test('type errors throw ExprError', () => {
  for (const [src, env] of [
    ['1 + "a"', {}],
    ['1 and true', {}],
    ['not 1', {}],
    ['all(x in [1]: 1)', {}],
    ['all(x in 5: true)', {}],
    ['1 / 0', {}],
    ['1 % 0', {}],
    ['xs[3]', { xs: [1] }],
    ['xs[-1]', { xs: [1] }],
    ['xs[0.5]', { xs: [1] }],
    ['r.missing', { r: {} }],
    ['r["missing"]', { r: {} }],
    ['r[1]', { r: {} }],
    ['(5)[0]', {}],
    ['(5).a', {}],
    ['nope', {}],
    ['min([])', {}],
    ['min(5)', {}],
    ['1 < "a"', {}],
    ['[1] < [2]', {}],
    ['len(5)', {}],
    ['sum([true])', {}],
    ['range(200000)', {}],
    ['round(1, 20)', {}],
    ['sorted([1, "a"])', {}],
    ['keys([1])', {}],
    ['-"a"', {}],
  ] as const) {
    assert.throws(() => ev(src, env), ExprError, src);
  }
});

test('syntax errors carry a position', () => {
  for (const src of ['1 +', '(1', 'foo(1)', 'len(1, 2)', 'perm(1)', '1 < 2 < 3', '"abc', '1 @ 2', 'a.', '{a: 1, a: 2}', 'all(x xs: true)', '1e999', '"\\q"', '1 2', '']) {
    assert.throws(() => expr.parse(src), (e: unknown) => e instanceof ExprError && typeof e.pos === 'number', src);
  }
});

test('refuses prototype access and eval-like escapes', () => {
  for (const src of ['x.__proto__', 'x.constructor', 'x.prototype', '{__proto__: 1}', '{"constructor": 1}', 'constructor', 'eval("1")', 'Function("x")', 'len.constructor']) {
    assert.throws(() => expr.parse(src), ExprError, src);
  }
  // String keys that name prototype members are only ever own-property lookups.
  assert.throws(() => ev('x["constructor"]', { x: {} }), ExprError);
  assert.throws(() => ev('x["__proto__"]', { x: {} }), ExprError);
  assert.throws(() => ev('toString', {}), ExprError);
  assert.throws(() => ev('x.toString', { x: {} }), ExprError);
});

test('numbers compare with a relative tolerance', () => {
  assert.equal(ev('0.1 + 0.2 == 0.3'), true);
  assert.equal(ev('a + b == 60.77', { a: 60.72, b: 0.05 }), true);
  assert.equal(ev('0.1 + 0.2 <= 0.3 and not (0.1 + 0.2 > 0.3) and not (0.1 + 0.2 < 0.3)'), true);
  assert.equal(ev('1 == 1.000001'), false);
  assert.equal(ev('1 < 1.000001'), true);
  assert.equal(ev('count([0.1 + 0.2], 0.3) == 1 and perm([0.1 + 0.2], [0.3]) and not unique([0.3, 0.1 + 0.2])'), true);
  assert.equal(ev('[true] == [1]'), false);
});

test('one evaluate() is capped at 1e6 steps; separate calls do not accumulate', () => {
  assert.throws(() => ev('all(i in range(100000): all(j in range(100000): true))'), /too expensive/);
  assert.throws(() => ev('unique(range(2000))'), /too expensive/);
  assert.throws(() => ev('perm(range(1001), range(1001))'), /too expensive/);
  const e = expr.parse('all(i in range(1000): all(j in range(998): true))');
  assert.equal(expr.evaluate(e, {}), true);
  assert.equal(expr.evaluate(e, {}), true);
});

// Every sample is evaluated in JS and in Python; both must agree on the value, or both must fail.
const PARITY: [string, Record<string, unknown>][] = [
  ['all(i in range(len(out)-1): out[i] <= out[i+1])', { out: [1, 2, 2, 5] }],
  ['all(i in range(len(out)-1): out[i] <= out[i+1])', { out: [2, 1] }],
  ['perm(out, xs)', { out: [1, [2], { a: 1 }], xs: [{ a: 1 }, 1, [2]] }],
  ['perm(out, xs)', { out: [1, 1, 2], xs: [1, 2, 2] }],
  ['unique(xs)', { xs: [1, 2, 1.0] }],
  ['count(xs, true)', { xs: [1, true, true] }],
  ['[1, true] == [1, 1]', {}],
  ['{a: 1, b: 2} == r', { r: { b: 2, a: 1 } }],
  ['-7 % 3', {}],
  ['7.5 % -2', {}],
  ['7 / 2', {}],
  ['len(xs) / 2', { xs: [1, 2, 3, 4] }],
  ['xs[len(xs) / 2]', { xs: [1, 2, 3, 4] }],
  ['xs[len(xs) / 2]', { xs: [1, 2, 3] }],
  ['round(2.5) + round(-2.5) + round(0.49999)', {}],
  ['round(2.675, 2)', {}],
  ['round(x, 1)', { x: -1.25 }],
  ['range(round(2.6))', {}],
  ['sum([0.1, 0.2, 0.3])', {}],
  ['sum([1e16, 1, -1e16])', {}],
  ['sorted(["b", "a", "B", "é"])', {}],
  ['sorted([3, -1, 2.5])', {}],
  ['min("b", "a", "c") + max(["x", "y"])', {}],
  ['keys(r) + values(r)', { r: { b: 1, a: 2, '1': 3 } }],
  ['len(s) + len(r) + len(xs)', { s: 'héllo😀', r: { a: 1 }, xs: [1, 2] }],
  ['s[5]', { s: 'héllo😀' }],
  ['"B" < "a" and "a" < "aa"', {}],
  ['any(x in xs: x.v > 2) implies out', { xs: [{ v: 1 }, { v: 3 }], out: false }],
  ['false and nope', {}],
  ['true and nope', {}],
  ['1 + true', {}],
  ['1 < "a"', {}],
  ['1 / 0', {}],
  ['xs[-1]', { xs: [1] }],
  ['xs[0.5]', { xs: [1] }],
  ['r.nope', { r: {} }],
  ['min([])', {}],
  ['range(100001)', {}],
  ['not 1', {}],
  ['abs(-3) * 2 - 1', {}],
  ['all(x in [1, 2]: any(x in [5]: x == 5)) and x == 9', { x: 9 }],
  ['null == null and null != 0 and [] != {} and "" != 0', {}],
  ['[1] + [2] == [1, 2] and "a" + "b" == "ab"', {}],
  ['{k: [1, {z: null}]}', {}],
  ['0.1 + 0.2 == 0.3 and a + b == 60.77', { a: 60.72, b: 0.05 }],
  ['[0.1 + 0.2 < 0.3, 0.1 + 0.2 <= 0.3, 1 == 1.000001, 1 < 1.000001, 3 == 3.0000000001]', {}],
  ['count([0.1 + 0.2], 0.3) + len(sorted([0.3, 0.1 + 0.2, 0.2]))', {}],
  ['all(i in range(100000): all(j in range(100000): true))', {}],
  ['unique(range(2000))', {}],
  ['all(i in range(1000): all(j in range(998): true))', {}],
];

test('toPython behaves identically under Python', (t) => {
  const py = spawnSync('python', ['--version']);
  if (py.status !== 0) return t.skip('python not installed');
  const js = PARITY.map(([src, env]) => {
    try {
      return { v: JSON.parse(JSON.stringify(ev(src, env))) };
    } catch (e) {
      assert.ok(e instanceof ExprError, `${src}: ${e}`);
      return { err: true };
    }
  });
  const runner = `
import json, sys
ns = {}
exec(json.loads(sys.argv[1]), ns)
out = []
for code, env in json.load(sys.stdin):
    ns["env"] = env
    try:
        out.append({"v": eval(code, ns)})
    except ns["ExprError"]:
        out.append({"err": True})
print(json.dumps(out))
`;
  const input = JSON.stringify(PARITY.map(([src, env]) => [expr.toPython(expr.parse(src)), env]));
  const r = spawnSync('python', ['-c', runner, JSON.stringify(PY_HELPERS)], { input, encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const pyOut = JSON.parse(r.stdout) as unknown[];
  PARITY.forEach(([src], i) => assert.deepEqual(pyOut[i], js[i], `${src}\n  python: ${expr.toPython(expr.parse(src))}`));
});
