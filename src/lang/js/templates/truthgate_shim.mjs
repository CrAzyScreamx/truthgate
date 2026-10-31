// truthgate shim (JS/TS). Generic and bundled: users never save or edit it.
// Run: node --import <tsx loader> truthgate_shim.mjs, with env TRUTHGATE_ROOT and TRUTHGATE_TARGET="path/to/file.ts::name".
// tsx compiles the target with the project's tsconfig: decorators, parameter properties, extensionless imports,
// `paths` aliases and CommonJS all load. A child process, not in-process, so the runner can kill a hung target.
// Protocol (JSON Lines): in {"op":"call","fn":..,"input":{..},"observe"?:name} | {"op":"reset","args"?:[..]} | {"op":"state"}
//                        out {"out":..} | {"error":"msg","kind":"rejected|crash"}
// function specs: calls the named export with the input values as positional args, in spec order (fresh copies per call).
//   observe: reply with that argument's value after the call (for functions that mutate it) instead of the return value.
// sequence specs: target is a class (reset = new, with `args`) or a factory (reset = call); ops are methods; state = state() or own fields.
// Rejected (the function refused the input): a RangeError (except stack overflow), or any error whose name is "Rejected"
//   (class Rejected extends Error { name = 'Rejected' }). Everything else, TypeError included, is a crash.
// Outputs cross JSON: undefined -> null; generators, iterators and Sets -> arrays; Map -> object; BigInt or cycles -> crash.
// A target that fails to import, or a missing function, exits with a one-line reason (shim error).
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const write = process.stdout.write.bind(process.stdout);
for (const k of ['log', 'info', 'debug', 'warn']) console[k] = console.error; // user prints must not corrupt the protocol
const die = (msg) => {
  process.stderr.write(`truthgate shim: ${msg}\n`);
  process.exit(3);
};
const target = process.env.TRUTHGATE_TARGET;
const i = target.lastIndexOf('::');
const [file, name] = [target.slice(0, i), target.slice(i + 2)];
let mod;
try {
  mod = await import(pathToFileURL(join(process.env.TRUTHGATE_ROOT, file)).href);
} catch (e) {
  die(`cannot load ${file}: ${e?.code ? e.code + ': ' : ''}${String(e?.message ?? e).split('\n')[0]}`);
}
// CommonJS targets (module: commonjs) arrive as a namespace whose named exports may only be on `default`.
const ns = name in mod ? mod : (mod.default ?? mod);
const ctor = ns[name];
if (typeof ctor !== 'function') die(`${file} has no exported function or class "${name}"`);
const isClass = /^class[\s{]/.test(Function.prototype.toString.call(ctor));
let obj = null;

/** JSON.stringify replacer: iterables that would otherwise vanish ({} or undefined) become arrays/objects. */
const plain = (_k, v) => {
  if (v instanceof Map) return Object.fromEntries(v);
  if (v instanceof Set) return [...v];
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v[Symbol.iterator] === 'function' && typeof v.next === 'function') return [...v];
  return v;
};
const reply = (m) => {
  let text;
  try {
    text = JSON.stringify(m, plain);
  } catch (e) {
    text = JSON.stringify({ error: `unserialisable output: ${e.message}`, kind: 'crash' });
  }
  write(text + '\n');
};

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const m = JSON.parse(line);
  let f;
  if (m.op === 'call') {
    f = obj ? obj[m.fn] : m.fn === name ? ctor : ns[m.fn];
    if (typeof f !== 'function') die(`"${m.fn}" is not a function on ${target}`);
  }
  try {
    let out = null;
    if (m.op === 'reset') obj = isClass ? new ctor(...(m.args ?? [])) : await ctor(...(m.args ?? []));
    else if (m.op === 'state') out = typeof obj?.state === 'function' ? await obj.state() : { ...obj };
    else {
      const args = Object.values(m.input);
      out = await f.apply(obj, args);
      if (m.observe) out = args[Object.keys(m.input).indexOf(m.observe)];
    }
    reply({ out: out ?? null });
  } catch (e) {
    // A stack overflow is a RangeError in V8, but it is a bug, not a refusal.
    const rejected = (e instanceof RangeError && !/call stack/i.test(e.message)) || e?.name === 'Rejected';
    reply({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), kind: rejected ? 'rejected' : 'crash' });
  }
}
