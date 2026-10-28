// truthgate shim (JS/TS). Generic and bundled: users never save or edit it.
// Run: node truthgate_shim.mjs, with env TRUTHGATE_ROOT and TRUTHGATE_TARGET="path/to/file.ts::name" (Node 24 strips TS types).
// A child process, not in-process, so the runner can kill a hung target at the deadline.
// Protocol (JSON Lines): in {"op":"call","fn":..,"input":{..}} | {"op":"reset"} | {"op":"state"}
//                        out {"out":..} | {"error":"msg","kind":"rejected|crash"}
// function specs: calls the named export with the input values as positional args, in spec order (fresh copies per call).
// sequence specs: target is a class (reset = new) or a factory (reset = call); ops are methods; state = state() or own fields.
// Rejected (the function refused the input): a RangeError, or any error whose name is "Rejected"
//   (class Rejected extends Error { name = 'Rejected' }). Everything else, TypeError included, is a crash.
// Outputs cross JSON (undefined -> null, Map -> {}); BigInt or cycles -> crash. A missing function exits (shim error).
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const write = process.stdout.write.bind(process.stdout);
for (const k of ['log', 'info', 'debug']) console[k] = console.error; // user prints must not corrupt the protocol
const die = (msg) => {
  process.stderr.write(`truthgate shim: ${msg}\n`);
  process.exit(3);
};
const target = process.env.TRUTHGATE_TARGET;
const i = target.lastIndexOf('::');
const [file, name] = [target.slice(0, i), target.slice(i + 2)];
const mod = await import(pathToFileURL(join(process.env.TRUTHGATE_ROOT, file)).href);
const ctor = mod[name];
if (typeof ctor !== 'function') die(`${file} has no exported function or class "${name}"`);
const isClass = /^class[\s{]/.test(Function.prototype.toString.call(ctor));
let obj = null;

const reply = (m) => {
  let text;
  try {
    text = JSON.stringify(m);
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
    f = obj ? obj[m.fn] : m.fn === name ? ctor : mod[m.fn];
    if (typeof f !== 'function') die(`"${m.fn}" is not a function on ${target}`);
  }
  try {
    let out = null;
    if (m.op === 'reset') obj = isClass ? new ctor() : await ctor();
    else if (m.op === 'state') out = typeof obj?.state === 'function' ? await obj.state() : { ...obj };
    else out = await f.apply(obj, Object.values(m.input));
    reply({ out: out ?? null });
  } catch (e) {
    const rejected = e instanceof RangeError || e?.name === 'Rejected';
    reply({ error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), kind: rejected ? 'rejected' : 'crash' });
  }
}
