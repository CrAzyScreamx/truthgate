import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { LanguageAdapter, Spec, TypeSpec } from '../../contract.ts';
import { parseType } from '../../core/typespec.ts';
import { probe } from '../../runner/proc.ts';
import { openShim } from '../../runner/shim.ts';
import { argOrder, bundledTemplate, missingShim, safeId, shimCommand, splitTarget } from '../common.ts';

const rustTy = (t: TypeSpec): string =>
  t.t === 'int' ? 'i64' : t.t === 'decimal' ? 'f64' : t.t === 'str' ? 'String' : t.t === 'bool' ? 'bool' : t.t === 'list' ? `Vec<${rustTy(t.of)}>` : 'J';

const example = (spec: Spec) => `truthgate_${safeId(spec.id)}`;

/** Library crate name from Cargo.toml ([lib] name, else [package] name with - -> _). */
function crateName(root: string): string {
  try {
    const t = parseToml(readFileSync(join(root, 'Cargo.toml'), 'utf8')) as { lib?: { name?: string }; package?: { name?: string } };
    return (t.lib?.name ?? t.package?.name ?? 'your_crate').replace(/-/g, '_');
  } catch {
    return 'your_crate /* TODO: your crate name */';
  }
}

/** src/lib.rs -> crate root; src/a.rs or src/a/mod.rs -> a; src/a/b.rs -> a::b. */
function modulePath(file: string): string {
  const m = file.replace(/^src\//, '').replace(/\.rs$/, '').replace(/(^|\/)(lib|mod)$/, '');
  return m.split('/').filter(Boolean).join('::');
}

export function rustTemplate(spec: Spec, root: string): { path: string; source: string } {
  const { file, name } = splitTarget(spec);
  const seq = spec.kind === 'sequence';
  const mod = modulePath(file);
  const path = `examples/${example(spec)}.rs`;
  const argsOf = (fn: string, inputs: Record<string, string>) =>
    argOrder(spec, fn).map((k, i) => `arg::<${rustTy(parseType(inputs[k]!))}>(a, ${i})`).join(', ');
  const arms = seq
    ? (spec.ops ?? []).map((o) => `        "${o.name}" => o.as_mut().unwrap().${o.name}(${argsOf(o.name, o.inputs)}).tj(),`)
    : [`        "${name}" => target::${name}(${argsOf(name, spec.inputs)}).tj(),`];
  return {
    path,
    source: `// truthgate shim (Rust) for spec "${spec.id}". Save as ${path}; truthgate runs \`cargo run -q --example ${example(spec)}\`.
// Needs a library crate (src/lib.rs) with the target and its module \`pub\`. No dependencies: a tiny JSON reader/writer is included.
// Protocol (JSON Lines): in {"op":"call","fn":..,"input":{..}} | {"op":"reset"} | {"op":"state"}; out {"out":..} | {"error":..,"kind":..}
// Type mapping: int -> i64, decimal -> f64, str -> String, bool -> bool, list<T> -> Vec<T>, record/oneof -> J (raw JSON).
// Edit the calls in \`call\` if your signature differs (e.g. &[i64], i32, &str). Results: anything implementing Tj
// (ints, floats, bool, String, Vec, Option, maps); Result::Err(e) -> rejected; a panic -> crash.
// sequence specs: reset -> ${name}::new(); ops are methods; state -> its state() method.
#![allow(dead_code, unused_imports)]
use std::io::{BufRead, Write};
use ${crateName(root)}${mod ? `::${mod}` : ''} as target;

type Obj = ${seq ? `Option<target::${name}>` : '()'};

fn reset(o: &mut Obj) { ${seq ? `*o = Some(target::${name}::new());` : 'let _ = o;'} }

fn state(o: &mut Obj) -> J { ${seq ? 'o.as_ref().unwrap().state().tj()' : 'let _ = o; J::Null'} }

fn call(o: &mut Obj, f: &str, a: &[J]) -> J {
    let _ = &o;
    match f {
${arms.join('\n')}
        _ => die(&format!("no function {f}")),
    }
}

fn die(msg: &str) -> ! {
    eprintln!("truthgate shim: {msg}");
    std::process::exit(3)
}

fn arg<T: Fj>(a: &[J], i: usize) -> T {
    T::fj(a.get(i).unwrap_or(&J::Null)).unwrap_or_else(|e| die(&format!("arg {i}: {e}")))
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let mut out = std::io::stdout().lock();
    let mut o: Obj = Default::default();
    for line in std::io::stdin().lock().lines() {
        let msg = parse(&line.unwrap());
        let op = if let Some(J::S(s)) = msg.get("op") { s.clone() } else { die("bad request") };
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match op.as_str() {
            "reset" => { reset(&mut o); J::Null }
            "state" => state(&mut o),
            _ => {
                let f = if let Some(J::S(s)) = msg.get("fn") { s.clone() } else { die("bad request") };
                let a: Vec<J> = if let Some(J::O(v)) = msg.get("input") { v.iter().map(|e| e.1.clone()).collect() } else { vec![] };
                call(&mut o, &f, &a)
            }
        }));
        let reply = match r {
            Ok(J::Rej(e)) => J::O(vec![("error".into(), J::S(e)), ("kind".into(), J::S("rejected".into()))]),
            Ok(v) => J::O(vec![("out".into(), v)]),
            Err(p) => {
                let m = p.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| p.downcast_ref::<String>().cloned()).unwrap_or_default();
                J::O(vec![("error".into(), J::S(format!("panic: {m}"))), ("kind".into(), J::S("crash".into()))])
            }
        };
        writeln!(out, "{reply}").unwrap();
        out.flush().unwrap();
    }
}
${readFileSync(bundledTemplate('rust', 'json.rs'), 'utf8')}`,
  };
}

export const rustAdapter: LanguageAdapter = {
  lang: 'rust',
  available: (root) => probe(['cargo', '--version'], 'cargo', root),
  async open(spec, root) {
    const path = `examples/${example(spec)}.rs`;
    if (spec.shim) {
      const { command, cwd } = shimCommand(spec, root, join(root, path), []);
      return openShim(command, cwd);
    }
    if (!existsSync(join(root, path))) throw missingShim(spec, path);
    return openShim(['cargo', 'run', '-q', '--example', example(spec)], root);
  },
  shimTemplate: (spec: Spec, root = process.cwd()) => rustTemplate(spec, root),
  testFileGlobs: ['**/tests/**/*.rs'],
  skipMarkers: [/#\[\s*ignore\b/],
  assertPatterns: [/\b(debug_)?assert(_eq|_ne)?!\s*\(/],
  lineComment: '//',
};
