import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CallResult, Lang, LanguageAdapter } from '../../contract.ts';
import { argOrder, SetupError, splitTarget } from '../common.ts';

const isClass = (f: Function) => /^class[\s{]/.test(Function.prototype.toString.call(f));

/** Outputs cross the same JSON boundary as a shim would (undefined -> null, Map -> {}, ...). */
const toJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v) ?? 'null');

/** RangeError/TypeError mean the function refused the input (mirrors Python's ValueError/TypeError). */
async function guard(run: () => unknown): Promise<CallResult> {
  let out: unknown;
  try {
    out = await run();
  } catch (e) {
    const kind = e instanceof RangeError || e instanceof TypeError ? 'rejected' : 'crash';
    return { ok: false, kind, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
  try {
    return { ok: true, out: toJson(out) };
  } catch (e) {
    return { ok: false, kind: 'crash', error: `unserializable output: ${(e as Error).message}` };
  }
}

/**
 * In-process adapter: imports the target file (Node 24 strips TS types natively) and calls the named export
 * with the input values as positional args in spec `inputs` order. Inputs are cloned so in-place mutation
 * can't leak into the property check. Sequence specs: target is a class (reset = `new`) or a factory
 * (reset = call); ops are methods; state = `state()` if defined, else the object's own fields.
 * ponytail: in-process, so an infinite loop in user code can't be interrupted, and the target's own imports
 * stay cached across runs in a long-lived process (the MCP server). Move to a child process if that bites.
 */
function jsAdapter(lang: Lang): LanguageAdapter {
  const exts = lang === 'ts' ? ['ts', 'tsx', 'mts', 'cts'] : ['js', 'mjs', 'cjs', 'jsx'];
  return {
    lang,
    available: async () => true,
    async open(spec, root) {
      const { file, name } = splitTarget(spec);
      const mod = await import(`${pathToFileURL(join(root, file)).href}?t=${Date.now()}`);
      const target = mod[name];
      if (typeof target !== 'function') throw new SetupError(`${file} has no exported function or class "${name}"`);
      let obj: any = null;
      const fnOf = (fn: string) => {
        const f = obj ? obj[fn] : fn === name ? target : mod[fn];
        if (typeof f !== 'function') throw new SetupError(`"${fn}" is not a function on ${spec.target}`);
        return f as Function;
      };
      return {
        async call(fn, input) {
          const f = fnOf(fn);
          const args = argOrder(spec, fn).map((k) => structuredClone(input[k]));
          return guard(() => f.apply(obj, args));
        },
        async reset() {
          obj = isClass(target) ? new target() : await target();
        },
        async state() {
          const r = await guard(() => (typeof obj?.state === 'function' ? obj.state() : { ...obj }));
          if (!r.ok) throw new SetupError(`state failed: ${r.error}`);
          return r.out;
        },
        async close() {},
      };
    },
    shimTemplate: () => ({ path: '', source: `// ${lang}: no shim needed, truthgate imports the target file in-process.\n` }),
    testFileGlobs: exts.flatMap((e) => [`**/*.test.${e}`, `**/*.spec.${e}`, `**/__tests__/**/*.${e}`]),
    skipMarkers: [/\b(it|test|describe)\.skip\b/, /\bx(it|test|describe)\s*\(/, /\bskip:\s*true\b/, /\bt\.skip\s*\(/],
    assertPatterns: [/\bexpect\s*\(/, /\bassert(\.\w+)?\s*\(/],
    lineComment: '//',
  };
}

export const tsAdapter = jsAdapter('ts');
export const jsAdapterJs = jsAdapter('js');
