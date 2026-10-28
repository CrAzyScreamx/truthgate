import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Lang, Op, Property, Spec } from '../contract.ts';
import { parseType } from './typespec.ts';
import { expr } from './expr.ts';

export const SPEC_DIR = '.truthgate/specs';
const LANGS: Lang[] = ['python', 'ts', 'js', 'java', 'csharp', 'go', 'rust'];

export class SpecError extends Error {
  constructor(file: string, field: string, msg: string) {
    super(`${file}: ${field}: ${msg}`);
    this.name = 'SpecError';
  }
}

/** Target file part of `path::fn`. */
export const targetFile = (s: Pick<Spec, 'target'>) => s.target.split('::')[0]!;

export async function loadSpecs(root: string): Promise<Spec[]> {
  let names: string[];
  try {
    names = await readdir(join(root, SPEC_DIR));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const specs: Spec[] = [];
  for (const name of names.filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const file = `${SPEC_DIR}/${name}`;
    const spec = parseSpec(await readFile(join(root, file), 'utf8'), file);
    const dup = specs.find((s) => s.id === spec.id);
    if (dup) throw new SpecError(file, 'id', `"${spec.id}" is also used by ${dup.file}`);
    specs.push(spec);
  }
  return specs;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseSpec(text: string, file: string): Spec {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new SpecError(file, 'yaml', (e as Error).message.split('\n')[0]!);
  }
  const bad = (field: string, msg: string): never => {
    throw new SpecError(file, field, msg);
  };
  if (!isObj(raw)) return bad('(root)', 'expected a mapping');
  const known = ['id', 'target', 'lang', 'kind', 'inputs', 'requires', 'ensures', 'ops', 'invariant', 'runs', 'allowCrash', 'prove', 'shim'];
  for (const k of Object.keys(raw)) if (!known.includes(k)) bad(k, 'unknown field');

  const str = (v: unknown, field: string) => (typeof v === 'string' && v.trim() ? v : bad(field, 'expected a non-empty string'));
  const exprStr = (v: unknown, field: string) => {
    const s = str(v, field);
    try {
      expr.parse(s);
    } catch (e) {
      bad(field, (e as Error).message);
    }
    return s;
  };
  const inputs = (v: unknown, field: string) => {
    if (v === undefined || v === null) return {};
    if (!isObj(v)) return bad(field, 'expected a mapping of name: generator');
    const out: Record<string, string> = {};
    for (const [k, g] of Object.entries(v)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) bad(`${field}.${k}`, 'not a valid name');
      try {
        parseType(str(g, `${field}.${k}`));
      } catch (e) {
        if (e instanceof SpecError) throw e;
        bad(`${field}.${k}`, (e as Error).message);
      }
      out[k] = g as string;
    }
    return out;
  };
  const props = (v: unknown, field: string): Property[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) return bad(field, 'expected a list of {name, expr}');
    return v.map((p, i) => {
      if (!isObj(p)) return bad(`${field}[${i}]`, 'expected {name, expr}');
      return { name: str(p.name, `${field}[${i}].name`), expr: exprStr(p.expr, `${field}[${i}].expr`) };
    });
  };

  const id = str(raw.id, 'id');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) bad('id', 'use letters, digits, ".", "_" or "-"');
  const target = str(raw.target, 'target');
  const [path, fn, extra] = target.split('::');
  if (!path || !fn || extra !== undefined) bad('target', 'expected path/to/file.ext::functionName');
  if (path!.includes('\\') || path!.startsWith('/') || /^[A-Za-z]:/.test(path!) || path!.split('/').includes('..'))
    bad('target', 'path must be relative to the repo root, with forward slashes and no ".."');
  const lang = raw.lang as Lang;
  if (!LANGS.includes(lang)) bad('lang', `expected one of ${LANGS.join('|')}`);
  const kind = (raw.kind ?? 'function') as Spec['kind'];
  if (kind !== 'function' && kind !== 'sequence') bad('kind', 'expected function or sequence');

  const requires = raw.requires ?? [];
  if (!Array.isArray(requires)) bad('requires', 'expected a list of expressions');
  const spec: Spec = {
    id,
    target,
    lang,
    kind,
    inputs: inputs(raw.inputs, 'inputs'),
    requires: (requires as unknown[]).map((r, i) => exprStr(r, `requires[${i}]`)),
    ensures: props(raw.ensures, 'ensures'),
    file,
  };

  if (kind === 'function') {
    if (spec.ensures.length === 0) bad('ensures', 'a function spec needs at least one property');
    if (raw.ops !== undefined || raw.invariant !== undefined) bad('ops', 'ops/invariant are for kind: sequence');
  } else {
    if (!Array.isArray(raw.ops) || raw.ops.length === 0) return bad('ops', 'a sequence spec needs a list of ops');
    spec.ops = raw.ops.map((o, i): Op => {
      if (!isObj(o)) return bad(`ops[${i}]`, 'expected {name, inputs}');
      return { name: str(o.name, `ops[${i}].name`), inputs: inputs(o.inputs, `ops[${i}].inputs`) };
    });
    spec.invariant = props(raw.invariant, 'invariant');
    if (spec.invariant.length === 0) bad('invariant', 'a sequence spec needs at least one invariant');
  }

  if (raw.runs !== undefined) {
    if (!Number.isInteger(raw.runs) || (raw.runs as number) < 1) bad('runs', 'expected a positive integer');
    spec.runs = raw.runs as number;
  }
  if (raw.allowCrash !== undefined) {
    if (typeof raw.allowCrash !== 'boolean') bad('allowCrash', 'expected true or false');
    spec.allowCrash = raw.allowCrash as boolean;
  }
  if (raw.prove !== undefined) {
    const p = raw.prove;
    if (!isObj(p)) return bad('prove', 'expected {tool, file, theorem}');
    if (p.tool !== 'rocq' && p.tool !== 'dafny') bad('prove.tool', 'expected rocq or dafny');
    const pf = str(p.file, 'prove.file');
    if (pf.startsWith('/') || /^[A-Za-z]:/.test(pf) || pf.split(/[\\/]/).includes('..')) bad('prove.file', 'must be relative to the repo root without ".."');
    spec.prove = { tool: p.tool as 'rocq' | 'dafny', file: pf, theorem: str(p.theorem, 'prove.theorem') };
  }
  if (raw.shim !== undefined) {
    const s = raw.shim;
    if (!isObj(s) || !Array.isArray(s.command) || s.command.length === 0) return bad('shim', 'expected {command: [..], cwd?}');
    spec.shim = { command: s.command.map((c, i) => str(c, `shim.command[${i}]`)) };
    if (s.cwd !== undefined) spec.shim.cwd = str(s.cwd, 'shim.cwd');
  }
  return spec;
}
