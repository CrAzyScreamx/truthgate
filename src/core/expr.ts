import type { Expr, ExprApi, Helper } from '../contract.ts';

// Semantics (identical in `evaluate` and in the Python emitted by `toPython` + PY_HELPERS):
// - Values: null, bool, number, string, list, object. No truthiness: and/or/not/implies, quantifier
//   bodies need bools. Comparisons need two numbers or two strings (strings by code point) and do
//   not chain. `==`/`!=` are deep structural equality; a bool never equals a number.
// - `+` adds numbers or concatenates strings/lists. `/` is true division, `%` is floor modulo
//   (Python's); either by zero is an error. `a[i]` indexes lists and strings (by code point,
//   0 <= i < len) or objects (string key). `a.b` reads an own field of an object.
// - Helpers: len(x) of list/string/object · sum(xs) · min/max(xs) or min/max(a, b, ...) ·
//   abs(n) · round(x, places=0) half away from zero · sorted(xs) ascending · perm(a, b): b is a
//   rearrangement of a · unique(xs): no two elements equal · count(xs, v): elements equal to v ·
//   range(n) / range(a, b) (at most 100000 items) · keys(o) / values(o) in sorted key order.
// - Integers compare exactly. Other numbers are equal within 1e-12 * max(1, |a|, |b|) (==, !=,
//   ordering, and the equality inside perm/unique/count), so decimal inputs don't drift.
// - One evaluate() may take at most 1e6 steps: quantifier iterations, perm/unique comparisons, and
//   the size of every list built (literals, +, range, sorted, keys, values) or scanned (sum, count).
// - Any type error, missing field/variable or bad index throws ExprError (Python: ExprError).
// ponytail: numbers are JS doubles; Python ints beyond 2^53 can disagree with the JS evaluator.

export class ExprError extends Error {
  pos?: number;
  constructor(msg: string, pos?: number) {
    super(pos === undefined ? msg : `${msg} (at ${pos})`);
    this.name = 'ExprError';
    this.pos = pos;
  }
}

/** The step cap was hit: the property is too expensive to evaluate, which says nothing about the code. */
export class ExprCostError extends ExprError {}

const HELPER_ARITY: Record<Helper, [number, number]> = {
  len: [1, 1], sum: [1, 1], min: [1, Infinity], max: [1, Infinity], abs: [1, 1], round: [1, 2],
  sorted: [1, 1], perm: [2, 2], unique: [1, 1], count: [2, 2], range: [1, 2], keys: [1, 1], values: [1, 1],
};
const KEYWORDS = new Set(['and', 'or', 'not', 'implies', 'in', 'true', 'false', 'null', 'all', 'any']);
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const RANGE_MAX = 100000;
const STEP_MAX = 1_000_000;
// ponytail: one relative tolerance absorbs float drift from summing up to ~1e4 decimal terms and still
// sees a 1-cent error on totals up to ~1e10; beyond that, compare scaled integers (cents) in the spec.
const TOL = 1e-12;

// Step budget for the current evaluate() call (evaluate is synchronous, so one counter suffices).
let steps = 0;
const tick = (n = 1) => {
  if ((steps += n) > STEP_MAX) throw new ExprCostError(`expression too expensive: more than ${STEP_MAX} steps`);
};
const numEq = (a: number, b: number) =>
  a === b || (!(Number.isInteger(a) && Number.isInteger(b)) && Math.abs(a - b) <= TOL * Math.max(1, Math.abs(a), Math.abs(b)));
const sized = <T extends unknown[]>(xs: T) => (tick(xs.length), xs);

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

type Tok = { type: 'num' | 'str' | 'id' | 'op' | 'end'; v: string; n?: number; pos: number };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^\d+(\.\d+)?([eE][-+]?\d+)?/.exec(rest))) {
      const n = Number(m[0]);
      if (!Number.isFinite(n)) throw new ExprError('number too large', i);
      toks.push({ type: 'num', v: m[0], n, pos: i });
      i += m[0].length;
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      toks.push({ type: 'id', v: m[0], pos: i });
      i += m[0].length;
    } else if (c === '"' || c === "'") {
      const start = i;
      let s = '';
      for (i++; src[i] !== c; i++) {
        if (i >= src.length) throw new ExprError('unclosed string', start);
        let ch = src[i]!;
        if (ch === '\\') {
          const e = src[++i];
          if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 1, i + 5))) {
            ch = String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16));
            i += 4;
          } else if (e !== undefined && Object.hasOwn(ESCAPES, e)) ch = ESCAPES[e]!;
          else throw new ExprError('bad escape', i);
        }
        s += ch;
      }
      i++;
      toks.push({ type: 'str', v: s, pos: start });
    } else if ((m = /^(==|!=|<=|>=|[-+*/%<>()[\]{},:.])/.exec(rest))) {
      toks.push({ type: 'op', v: m[0], pos: i });
      i += m[0].length;
    } else throw new ExprError(`unexpected "${c}"`, i);
  }
  toks.push({ type: 'end', v: '', pos: src.length });
  return toks;
}
const ESCAPES: Record<string, string> = { '\\': '\\', '"': '"', "'": "'", n: '\n', t: '\t', r: '\r' };

function parse(src: string): Expr {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p]!;
  const isOp = (v: string) => peek().type === 'op' && peek().v === v;
  const isKw = (v: string) => peek().type === 'id' && peek().v === v;
  const expect = (v: string) => {
    if (!isOp(v) && !isKw(v)) throw new ExprError(`expected "${v}"`, peek().pos);
    p++;
  };
  const name = (what: string) => {
    const t = peek();
    if (t.type !== 'id' || KEYWORDS.has(t.v)) throw new ExprError(`expected ${what}`, t.pos);
    if (FORBIDDEN.has(t.v)) throw new ExprError(`"${t.v}" is not allowed`, t.pos);
    p++;
    return t.v;
  };

  const implies = (): Expr => {
    const l = or();
    if (!isKw('implies')) return l;
    p++;
    return { k: 'bin', op: 'implies', l, r: implies() };
  };
  const or = (): Expr => {
    let l = and();
    while (isKw('or')) {
      p++;
      l = { k: 'bin', op: 'or', l, r: and() };
    }
    return l;
  };
  const and = (): Expr => {
    let l = not();
    while (isKw('and')) {
      p++;
      l = { k: 'bin', op: 'and', l, r: not() };
    }
    return l;
  };
  const not = (): Expr => {
    if (!isKw('not')) return cmp();
    p++;
    return { k: 'un', op: 'not', arg: not() };
  };
  const CMP = ['==', '!=', '<', '<=', '>', '>='] as const;
  const cmp = (): Expr => {
    const l = add();
    const op = CMP.find(isOp);
    if (!op) return l;
    p++;
    const e: Expr = { k: 'bin', op, l, r: add() };
    if (CMP.some(isOp)) throw new ExprError('chained comparison; use "and"', peek().pos);
    return e;
  };
  const add = (): Expr => {
    let l = mul();
    for (let op; (op = (['+', '-'] as const).find(isOp)); ) {
      p++;
      l = { k: 'bin', op, l, r: mul() };
    }
    return l;
  };
  const mul = (): Expr => {
    let l = unary();
    for (let op; (op = (['*', '/', '%'] as const).find(isOp)); ) {
      p++;
      l = { k: 'bin', op, l, r: unary() };
    }
    return l;
  };
  const unary = (): Expr => {
    if (!isOp('-')) return postfix();
    p++;
    return { k: 'un', op: '-', arg: unary() };
  };
  const postfix = (): Expr => {
    let e = primary();
    for (;;) {
      if (isOp('.')) {
        p++;
        e = { k: 'get', obj: e, key: name('a field name') };
      } else if (isOp('[')) {
        p++;
        const index = implies();
        expect(']');
        e = { k: 'index', obj: e, index };
      } else return e;
    }
  };
  const list = (close: string, item: () => void) => {
    if (!isOp(close)) {
      do item();
      while (isOp(',') && (p++, true));
    }
    expect(close);
  };
  const primary = (): Expr => {
    const t = peek();
    if (t.type === 'num') return p++, { k: 'lit', v: t.n };
    if (t.type === 'str') return p++, { k: 'lit', v: t.v };
    if (t.type === 'op') {
      p++;
      if (t.v === '(') {
        const e = implies();
        expect(')');
        return e;
      }
      if (t.v === '[') {
        const items: Expr[] = [];
        list(']', () => items.push(implies()));
        return { k: 'list', items };
      }
      if (t.v === '{') {
        const entries: [string, Expr][] = [];
        list('}', () => {
          const kt = peek();
          const key = kt.type === 'str' ? (p++, kt.v) : name('a key');
          if (FORBIDDEN.has(key)) throw new ExprError(`"${key}" is not allowed`, kt.pos);
          if (entries.some(([k]) => k === key)) throw new ExprError(`duplicate key "${key}"`, kt.pos);
          expect(':');
          entries.push([key, implies()]);
        });
        return { k: 'obj', entries };
      }
      throw new ExprError(`unexpected "${t.v}"`, t.pos);
    }
    if (t.type === 'id') {
      if (t.v === 'true' || t.v === 'false') return p++, { k: 'lit', v: t.v === 'true' };
      if (t.v === 'null') return p++, { k: 'lit', v: null };
      if (t.v === 'all' || t.v === 'any') {
        p++;
        expect('(');
        const v = name('a variable');
        expect('in');
        const over = implies();
        expect(':');
        const body = implies();
        expect(')');
        return { k: 'quant', q: t.v, v, over, body };
      }
      const id = name('a value');
      if (!isOp('(')) return { k: 'var', name: id };
      if (!Object.hasOwn(HELPER_ARITY, id)) throw new ExprError(`unknown function "${id}"`, t.pos);
      p++;
      const args: Expr[] = [];
      list(')', () => args.push(implies()));
      const [lo, hi] = HELPER_ARITY[id as Helper];
      if (args.length < lo || args.length > hi) throw new ExprError(`wrong number of arguments to ${id}`, t.pos);
      return { k: 'call', fn: id as Helper, args };
    }
    throw new ExprError('unexpected end of expression', t.pos);
  };

  const e = implies();
  if (peek().type !== 'end') throw new ExprError(`unexpected "${peek().v}"`, peek().pos);
  return e;
}

// ---------------------------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------------------------

type Env = Record<string, unknown>;

function tn(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'object') return 'object';
  return typeof v;
}
const fail = (msg: string): never => {
  throw new ExprError(msg);
};
const asBool = (v: unknown) => (typeof v === 'boolean' ? v : fail(`expected bool, got ${tn(v)}`));
const asNum = (v: unknown) => (typeof v === 'number' ? v : fail(`expected number, got ${tn(v)}`));
const asInt = (v: unknown) => (Number.isInteger(asNum(v)) ? (v as number) : fail(`expected integer, got ${v}`));
const asList = (v: unknown) => (Array.isArray(v) ? v : fail(`expected list, got ${tn(v)}`));
const asObj = (v: unknown) => (tn(v) === 'object' ? (v as Env) : fail(`expected object, got ${tn(v)}`));

export function deepEqual(a: unknown, b: unknown): boolean {
  const ta = tn(a);
  if (ta !== tn(b)) return false;
  if (ta === 'null') return true;
  if (ta === 'list') {
    const x = a as unknown[], y = b as unknown[];
    return x.length === y.length && x.every((v, i) => deepEqual(v, y[i]));
  }
  if (ta === 'object') {
    const x = a as Env, y = b as Env, kx = Object.keys(x);
    return kx.length === Object.keys(y).length && kx.every((k) => Object.hasOwn(y, k) && deepEqual(x[k], y[k]));
  }
  return ta === 'number' ? numEq(a as number, b as number) : a === b;
}

function cmp(a: unknown, b: unknown): number {
  const ta = tn(a), tb = tn(b);
  if (ta !== tb || (ta !== 'number' && ta !== 'string')) fail(`cannot compare ${ta} and ${tb}`);
  if (ta === 'number') return numEq(a as number, b as number) ? 0 : (a as number) < (b as number) ? -1 : 1;
  const x = [...(a as string)], y = [...(b as string)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d) return Math.sign(d);
  }
  return Math.sign(x.length - y.length);
}

function arith(op: string, a: unknown, b: unknown): unknown {
  if (op === '+') {
    const ta = tn(a), tb = tn(b);
    if (ta === tb && ta === 'number') return (a as number) + (b as number);
    if (ta === tb && ta === 'string') return (a as string) + (b as string);
    if (ta === tb && ta === 'list') return sized([...(a as unknown[]), ...(b as unknown[])]);
    return fail(`cannot add ${ta} and ${tb}`);
  }
  const x = asNum(a), y = asNum(b);
  if (op === '-') return x - y;
  if (op === '*') return x * y;
  if (y === 0) fail(op === '/' ? 'division by zero' : 'modulo by zero');
  if (op === '/') return x / y;
  const r = x % y;
  return r !== 0 && r < 0 !== y < 0 ? r + y : r;
}

function minmax(args: unknown[], sign: number, fn: string): unknown {
  const xs = args.length === 1 ? asList(args[0]) : args;
  if (xs.length === 0) fail(`${fn} of empty list`);
  let best = xs[0];
  for (const x of xs.slice(1)) if (cmp(x, best) * sign < 0) best = x;
  return best;
}

const sortedKeys = (o: Env) => Object.keys(o).sort(cmp);

const HELPERS: Record<Helper, (...a: unknown[]) => unknown> = {
  len(v) {
    const t = tn(v);
    if (t === 'list') return (v as unknown[]).length;
    if (t === 'string') return [...(v as string)].length;
    if (t === 'object') return Object.keys(v as Env).length;
    return fail(`len of ${t}`);
  },
  sum(xs) {
    let t = 0;
    for (const x of sized(asList(xs))) t = t + asNum(x);
    return t;
  },
  min: (...a) => minmax(a, 1, 'min'),
  max: (...a) => minmax(a, -1, 'max'),
  abs: (x) => Math.abs(asNum(x)),
  round(x, places = 0) {
    const n = asNum(x), p = asInt(places);
    if (p < 0 || p > 15) fail('round places must be 0..15');
    if (!Number.isFinite(n)) fail('round of non-finite number');
    const f = 10 ** p, y = n * f;
    const r = Math.floor(Math.abs(y) + 0.5) * (y < 0 ? -1 : 1);
    return p === 0 ? r : r / f;
  },
  sorted: (xs) => sized([...asList(xs)]).sort(cmp),
  perm(a, b) {
    const x = asList(a), y = asList(b);
    if (x.length !== y.length) return false;
    tick(x.length * y.length);
    const used = y.map(() => false);
    return x.every((v) => {
      const j = y.findIndex((w, k) => !used[k] && deepEqual(v, w));
      return j >= 0 && (used[j] = true);
    });
  },
  unique(xs) {
    const x = asList(xs);
    tick(x.length * x.length);
    return x.every((v, i) => x.slice(i + 1).every((w) => !deepEqual(v, w)));
  },
  count: (xs, v) => sized(asList(xs)).filter((x) => deepEqual(x, v)).length,
  range(a, b) {
    const [lo, hi] = b === undefined ? [0, asInt(a)] : [asInt(a), asInt(b)];
    if (hi - lo > RANGE_MAX) fail('range too large');
    tick(Math.max(0, hi - lo));
    return Array.from({ length: Math.max(0, hi - lo) }, (_, i) => lo + i);
  },
  keys: (o) => sized(sortedKeys(asObj(o))),
  values(o) {
    const x = asObj(o);
    return sized(sortedKeys(x)).map((k) => x[k]);
  },
};

function ev(e: Expr, env: Env): unknown {
  switch (e.k) {
    case 'lit':
      return e.v;
    case 'var':
      return Object.hasOwn(env, e.name) ? env[e.name] : fail(`unknown variable "${e.name}"`);
    case 'list':
      return sized(e.items.map((x) => ev(x, env)));
    case 'obj': {
      const o: Env = Object.create(null);
      for (const [k, v] of e.entries) o[k] = ev(v, env);
      return o;
    }
    case 'get': {
      const o = asObj(ev(e.obj, env));
      return Object.hasOwn(o, e.key) ? o[e.key] : fail(`no field "${e.key}"`);
    }
    case 'index': {
      const o = ev(e.obj, env), i = ev(e.index, env), t = tn(o);
      if (t === 'list' || t === 'string') {
        const xs = t === 'list' ? (o as unknown[]) : [...(o as string)], n = asInt(i);
        return n >= 0 && n < xs.length ? xs[n] : fail(`index ${n} out of range`);
      }
      if (t === 'object') {
        if (typeof i !== 'string') fail('object key must be a string');
        return Object.hasOwn(o as Env, i as string) ? (o as Env)[i as string] : fail(`no key "${i}"`);
      }
      return fail(`cannot index ${t}`);
    }
    case 'un':
      return e.op === 'not' ? !asBool(ev(e.arg, env)) : -asNum(ev(e.arg, env));
    case 'bin': {
      const { op } = e;
      if (op === 'and') return asBool(ev(e.l, env)) ? asBool(ev(e.r, env)) : false;
      if (op === 'or') return asBool(ev(e.l, env)) ? true : asBool(ev(e.r, env));
      if (op === 'implies') return asBool(ev(e.l, env)) ? asBool(ev(e.r, env)) : true;
      const l = ev(e.l, env), r = ev(e.r, env);
      if (op === '==') return deepEqual(l, r);
      if (op === '!=') return !deepEqual(l, r);
      if (op === '<') return cmp(l, r) < 0;
      if (op === '<=') return cmp(l, r) <= 0;
      if (op === '>') return cmp(l, r) > 0;
      if (op === '>=') return cmp(l, r) >= 0;
      return arith(op, l, r);
    }
    case 'quant': {
      const want = e.q === 'all';
      for (const x of asList(ev(e.over, env))) {
        tick();
        if (asBool(ev(e.body, { __proto__: null, ...env, [e.v]: x } as Env)) !== want) return !want;
      }
      return want;
    }
    case 'call':
      return HELPERS[e.fn](...e.args.map((a) => ev(a, env)));
  }
}

// ---------------------------------------------------------------------------------------------
// Python emitter. Run the output with PY_HELPERS in scope and the variables in a dict named `env`:
//   ns = {}; exec(PY_HELPERS, ns); ns["env"] = {"xs": [...], "out": [...]}; eval(code, ns)
// ---------------------------------------------------------------------------------------------

const PY_BIN: Record<string, string> = {
  '+': '_add', '-': '_sub', '*': '_mul', '/': '_div', '%': '_mod',
  '==': '_eq', '!=': '_ne', '<': '_lt', '<=': '_le', '>': '_gt', '>=': '_ge',
};

/** ASCII-only Python string literal (astral chars as \U escapes, so no surrogate pairs). */
const pyStr = (s: string) =>
  JSON.stringify(s).replace(/[^\x00-\x7f]/gu, (c) => {
    const n = c.codePointAt(0)!;
    return n > 0xffff ? `\\U${n.toString(16).padStart(8, '0')}` : `\\u${n.toString(16).padStart(4, '0')}`;
  });

function toPython(e: Expr, bound: ReadonlySet<string> = new Set()): string {
  const py = (x: Expr) => toPython(x, bound);
  switch (e.k) {
    case 'lit':
      if (e.v === null) return 'None';
      if (typeof e.v === 'boolean') return e.v ? 'True' : 'False';
      // Integers past 2^53 are doubles in JS; emit them as Python floats so arithmetic rounds alike.
      if (typeof e.v === 'number') return Number.isSafeInteger(e.v) || !/^\d+$/.test(String(e.v)) ? String(e.v) : `${e.v}.0`;
      return pyStr(e.v as string);
    case 'var':
      return bound.has(e.name) ? `v_${e.name}` : `_var(env, ${pyStr(e.name)})`;
    case 'list':
      return `_lst([${e.items.map(py).join(', ')}])`;
    case 'obj':
      return `{${e.entries.map(([k, v]) => `${pyStr(k)}: ${py(v)}`).join(', ')}}`;
    case 'get':
      return `_get(${py(e.obj)}, ${pyStr(e.key)})`;
    case 'index':
      return `_index(${py(e.obj)}, ${py(e.index)})`;
    case 'un':
      return e.op === 'not' ? `(not _bool(${py(e.arg)}))` : `_neg(${py(e.arg)})`;
    case 'bin':
      if (e.op === 'and') return `(_bool(${py(e.l)}) and _bool(${py(e.r)}))`;
      if (e.op === 'or') return `(_bool(${py(e.l)}) or _bool(${py(e.r)}))`;
      if (e.op === 'implies') return `((not _bool(${py(e.l)})) or _bool(${py(e.r)}))`;
      return `${PY_BIN[e.op]}(${py(e.l)}, ${py(e.r)})`;
    case 'quant':
      return `_${e.q}(${py(e.over)}, lambda v_${e.v}: ${toPython(e.body, new Set([...bound, e.v]))})`;
    case 'call':
      return `_${e.fn}(${e.args.map(py).join(', ')})`;
  }
}

export const PY_HELPERS = `import math, functools

class ExprError(Exception):
    pass

class ExprCostError(ExprError):
    pass

def _err(msg):
    raise ExprError(msg)

def _tn(v):
    if v is None: return "null"
    if isinstance(v, bool): return "bool"
    if isinstance(v, (int, float)): return "number"
    if isinstance(v, str): return "string"
    if isinstance(v, (list, tuple)): return "list"
    if isinstance(v, dict): return "object"
    return type(v).__name__

def _bool(v):
    if not isinstance(v, bool): _err("expected bool, got " + _tn(v))
    return v

def _num(v):
    if _tn(v) != "number": _err("expected number, got " + _tn(v))
    return v

def _int(v):
    _num(v)
    if isinstance(v, float):
        if not v.is_integer(): _err("expected integer, got " + repr(v))
        return int(v)
    return v

def _list(v):
    if _tn(v) != "list": _err("expected list, got " + _tn(v))
    return v

def _obj(v):
    if _tn(v) != "object": _err("expected object, got " + _tn(v))
    return v

def _var(env, name):
    if name not in env: _err("unknown variable " + name)
    return env[name]

def _get(o, k):
    o = _obj(o)
    if k not in o: _err("no field " + k)
    return o[k]

def _index(o, i):
    t = _tn(o)
    if t == "list" or t == "string":
        i = _int(i)
        if i < 0 or i >= len(o): _err("index " + str(i) + " out of range")
        return o[i]
    if t == "object":
        if not isinstance(i, str): _err("object key must be a string")
        if i not in o: _err("no key " + i)
        return o[i]
    _err("cannot index " + t)

_steps = [0]

def _tick(n=1):
    _steps[0] += n
    if _steps[0] > 1000000: raise ExprCostError("expression too expensive: more than 1000000 steps")

def _run(f):
    _steps[0] = 0
    return f()

def _isint(v):
    return isinstance(v, int) or v.is_integer()

def _numeq(a, b):
    if a == b: return True
    if _isint(a) and _isint(b): return False
    return abs(a - b) <= 1e-12 * max(1, abs(a), abs(b))

def _sized(xs):
    _tick(len(xs))
    return xs

def _lst(xs):
    return _sized(xs)

def _eq(a, b):
    ta = _tn(a)
    if ta != _tn(b): return False
    if ta == "list": return len(a) == len(b) and all(_eq(x, y) for x, y in zip(a, b))
    if ta == "object": return set(a) == set(b) and all(_eq(a[k], b[k]) for k in a)
    if ta == "number": return _numeq(a, b)
    return ta == "null" or a == b

def _ne(a, b):
    return not _eq(a, b)

def _cmp(a, b):
    ta, tb = _tn(a), _tn(b)
    if ta != tb or ta not in ("number", "string"): _err("cannot compare " + ta + " and " + tb)
    if ta == "number" and _numeq(a, b): return 0
    return (a > b) - (a < b)

def _lt(a, b): return _cmp(a, b) < 0
def _le(a, b): return _cmp(a, b) <= 0
def _gt(a, b): return _cmp(a, b) > 0
def _ge(a, b): return _cmp(a, b) >= 0

def _add(a, b):
    ta, tb = _tn(a), _tn(b)
    if ta == tb and ta in ("number", "string"): return a + b
    if ta == tb == "list": return _sized(list(a) + list(b))
    _err("cannot add " + ta + " and " + tb)

def _sub(a, b): return _num(a) - _num(b)
def _mul(a, b): return _num(a) * _num(b)
def _neg(a): return -_num(a)

def _div(a, b):
    _num(a)
    if _num(b) == 0: _err("division by zero")
    return a / b

def _mod(a, b):
    _num(a)
    if _num(b) == 0: _err("modulo by zero")
    return a % b

def _all(xs, f):
    for x in _list(xs):
        _tick()
        if not _bool(f(x)): return False
    return True

def _any(xs, f):
    for x in _list(xs):
        _tick()
        if _bool(f(x)): return True
    return False

def _len(v):
    t = _tn(v)
    if t in ("list", "string", "object"): return len(v)
    _err("len of " + t)

def _sum(xs):
    t = 0
    for x in _sized(_list(xs)): t = t + _num(x)
    return t

def _minmax(args, sign, fn):
    xs = _list(args[0]) if len(args) == 1 else args
    if len(xs) == 0: _err(fn + " of empty list")
    best = xs[0]
    for x in xs[1:]:
        if _cmp(x, best) * sign < 0: best = x
    return best

def _min(*a): return _minmax(a, 1, "min")
def _max(*a): return _minmax(a, -1, "max")
def _abs(x): return abs(_num(x))

def _round(x, p=0):
    _num(x)
    p = _int(p)
    if p < 0 or p > 15: _err("round places must be 0..15")
    if not math.isfinite(x): _err("round of non-finite number")
    f = 10 ** p
    y = x * f
    r = math.floor(abs(y) + 0.5) * (-1 if y < 0 else 1)
    return r if p == 0 else r / f

def _sorted(xs):
    return sorted(_sized(_list(xs)), key=functools.cmp_to_key(_cmp))

def _perm(a, b):
    a, b = _list(a), _list(b)
    if len(a) != len(b): return False
    _tick(len(a) * len(b))
    used = [False] * len(b)
    for x in a:
        for j, y in enumerate(b):
            if not used[j] and _eq(x, y):
                used[j] = True
                break
        else:
            return False
    return True

def _unique(xs):
    xs = _list(xs)
    _tick(len(xs) * len(xs))
    return not any(_eq(xs[i], xs[j]) for i in range(len(xs)) for j in range(i + 1, len(xs)))

def _count(xs, v):
    return sum(1 for x in _sized(_list(xs)) if _eq(x, v))

def _range(a, b=None):
    lo, hi = (0, _int(a)) if b is None else (_int(a), _int(b))
    if hi - lo > ${RANGE_MAX}: _err("range too large")
    _tick(max(0, hi - lo))
    return list(range(lo, hi))

def _keys(o):
    return _sized(sorted(_obj(o).keys()))

def _values(o):
    o = _obj(o)
    return [o[k] for k in _sized(sorted(o.keys()))]
`;

function evaluate(e: Expr, env: Env): unknown {
  steps = 0;
  return ev(e, env);
}

export const expr: ExprApi = { parse, evaluate, toPython: (e) => `_run(lambda: ${toPython(e)})` };
