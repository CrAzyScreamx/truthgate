import type { TypeSpec } from '../contract.ts';

// Generator syntax: int[a,b] decimal[a,b,places] str[max] bool list<T>[max] record{a:T,b:T} oneof[v1,v2,...]
// `str` and `list<T>` may omit [max]; the defaults below apply.
export const DEFAULT_STR_MAX = 20;
export const DEFAULT_LIST_MAX = 10;

export function parseType(src: string): TypeSpec {
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`bad type "${src}" at ${i}: ${msg}`);
  };
  const ws = () => {
    while (/\s/.test(src[i] ?? '')) i++;
  };
  const eat = (ch: string) => {
    ws();
    if (src[i] !== ch) fail(`expected "${ch}"`);
    i++;
  };
  const peek = (ch: string) => {
    ws();
    return src[i] === ch;
  };
  const word = () => {
    ws();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!m) fail('expected a name');
    i += m![0].length;
    return m![0];
  };
  const num = (intOnly = false) => {
    ws();
    const m = /^-?\d+(\.\d+)?([eE][-+]?\d+)?/.exec(src.slice(i));
    if (!m) fail('expected a number');
    const n = Number(m![0]);
    if (intOnly && !Number.isInteger(n)) fail('expected an integer');
    i += m![0].length;
    return n;
  };
  const optMax = (dflt: number) => {
    if (!peek('[')) return dflt;
    eat('[');
    const n = num(true);
    if (n < 0) fail('max must be >= 0');
    eat(']');
    return n;
  };

  const type = (): TypeSpec => {
    const name = word();
    switch (name) {
      case 'int': {
        eat('[');
        const min = num(true);
        eat(',');
        const max = num(true);
        eat(']');
        if (min > max) fail('min > max');
        return { t: 'int', min, max };
      }
      case 'decimal': {
        eat('[');
        const min = num();
        eat(',');
        const max = num();
        eat(',');
        const places = num(true);
        eat(']');
        if (min > max) fail('min > max');
        if (places < 0 || places > 15) fail('places must be 0..15');
        return { t: 'decimal', min, max, places };
      }
      case 'str':
        return { t: 'str', max: optMax(DEFAULT_STR_MAX) };
      case 'bool':
        return { t: 'bool' };
      case 'list': {
        eat('<');
        const of = type();
        eat('>');
        return { t: 'list', of, max: optMax(DEFAULT_LIST_MAX) };
      }
      case 'record': {
        eat('{');
        const fields: Record<string, TypeSpec> = {};
        if (!peek('}')) {
          do {
            const key = word();
            if (Object.hasOwn(fields, key)) fail(`duplicate field "${key}"`);
            eat(':');
            fields[key] = type();
          } while (peek(',') && (eat(','), true));
        }
        eat('}');
        return { t: 'record', fields };
      }
      case 'oneof': {
        ws();
        if (src[i] !== '[') fail('expected "["');
        // Find the matching "]" outside JSON strings, then let JSON.parse read the values.
        const start = i;
        let depth = 0;
        for (; i < src.length; i++) {
          const c = src[i];
          if (c === '"') {
            for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === '\\') i++;
          } else if (c === '[' || c === '{') depth++;
          else if (c === ']' || c === '}') {
            depth--;
            if (depth === 0) break;
          }
        }
        if (depth !== 0) fail('unclosed "["');
        let values: unknown;
        try {
          values = JSON.parse(src.slice(start, ++i));
        } catch {
          i = start;
          fail('oneof values must be JSON literals');
        }
        if (!Array.isArray(values) || values.length === 0) fail('oneof needs at least one value');
        return { t: 'oneof', values: values as unknown[] };
      }
      default:
        return fail(`unknown type "${name}"`);
    }
  };

  const t = type();
  ws();
  if (i < src.length) fail('trailing text');
  return t;
}

/** Plain-words description, used by `approve`. */
export function describeType(t: TypeSpec): string {
  switch (t.t) {
    case 'int':
      return `an integer from ${t.min} to ${t.max}`;
    case 'decimal':
      return `a decimal from ${t.min} to ${t.max} with ${t.places} places`;
    case 'str':
      return `a string of up to ${t.max} characters`;
    case 'bool':
      return 'true or false';
    case 'list':
      return `a list of up to ${t.max} items, each ${describeType(t.of)}`;
    case 'record':
      return `a record with ${Object.entries(t.fields).map(([k, v]) => `${k} = ${describeType(v)}`).join(', ') || 'no fields'}`;
    case 'oneof':
      return `one of ${t.values.map((v) => JSON.stringify(v)).join(', ')}`;
  }
}
