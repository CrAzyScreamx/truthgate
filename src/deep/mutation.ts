import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config, DeepReport, Lang, Spec } from '../contract.ts';
import type { Deps } from './index.ts';

export interface Mutant {
  file: string;
  line: number; // 1-based
  col: number; // 0-based, in the original line
  from: string;
  to: string;
  desc: string;
}

const MAX_MUTANTS = 5;
const MUTANT_RUNS = 25;
const EXCLUDE = new Set(['node_modules', '.git', 'target', 'bin', 'obj', 'build', '.venv']);

const SWAP: Record<string, string> = {
  '===': '!==', '!==': '===', '==': '!=', '!=': '==',
  '<=': '<', '>=': '>', '<': '<=', '>': '>=',
  '+': '-', '-': '+', '&&': '||', '||': '&&',
};
// Longest first. Tokens absent from SWAP (=>, ->, <<, ++, +=, ...) are consumed unmutated, which is
// what keeps `<=` from becoming `<==` and leaves arrows alone.
const OPS = [
  '<<=', '>>=', '===', '!==', '**=', '//=',
  '<=', '>=', '==', '!=', '=>', '->', '<-', '<<', '>>', '&&', '||', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '|=', '&=', '^=', '::', '**',
  '<', '>', '+', '-',
];
const GENERIC = /^<[\w\s,.?[\]<>:']*>/; // ' for Rust lifetimes
const IMPORT = /^\s*(import\b|from\s+[\w.]+\s+import\b|using\b|use\b|package\b|extern\s+crate\b|mod\s+\w+\s*;)/;
const ZERO: Record<Lang, string> = {
  python: 'None', ts: 'undefined', js: 'undefined', java: 'null', csharp: 'default', go: '0', rust: 'Default::default()',
};

/** Blank out strings and comments (newlines kept) so offsets still line up with the source. */
export function mask(src: string, lang: Lang, lineComment: string): string {
  const py = lang === 'python';
  const quoteStrings = py || lang === 'ts' || lang === 'js'; // elsewhere ' is a char literal (or a Rust lifetime)
  let out = '';
  let i = 0;
  const skipTo = (j: number) => {
    out += src.slice(i, j).replace(/[^\n]/g, ' ');
    i = j;
  };
  const endOf = (needle: string, from: number) => {
    const j = src.indexOf(needle, from);
    return j < 0 ? src.length : j + needle.length;
  };
  while (i < src.length) {
    const c = src[i]!;
    if (src.startsWith(lineComment, i)) {
      const j = src.indexOf('\n', i);
      skipTo(j < 0 ? src.length : j);
    } else if (!py && src.startsWith('/*', i)) {
      skipTo(endOf('*/', i + 2));
    } else if (py && (src.startsWith('"""', i) || src.startsWith("'''", i))) {
      skipTo(endOf(src.slice(i, i + 3), i + 3));
    } else if (c === '"' || (c === '`' && !py) || (c === "'" && quoteStrings)) {
      let j = i + 1;
      while (j < src.length && src[j] !== c && (c === '`' || src[j] !== '\n')) j += src[j] === '\\' ? 2 : 1;
      skipTo(Math.min(j + 1, src.length));
    } else if (c === "'") {
      const m = /^'(\\[^']*|[^\\'\n])'/.exec(src.slice(i, i + 12));
      if (m) {
        skipTo(i + m[0].length);
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Candidate mutations for one line. `m` is the masked line, `o` the original. */
export function lineMutants(file: string, line: number, o: string, m: string, lang: Lang): Mutant[] {
  const res: Mutant[] = [];
  const add = (col: number, from: string, to: string, desc: string) => res.push({ file, line, col, from, to, desc });
  let i = 0;
  while (i < m.length) {
    const word = /^\w+/.exec(m.slice(i))?.[0];
    if (word) {
      const prev = m[i - 1];
      if (lang === 'python' && (word === 'and' || word === 'or')) {
        const to = word === 'and' ? 'or' : 'and';
        add(i, word, to, `replaced '${word}' with '${to}'`);
      } else if (/^\d+$/.test(word) && prev !== '.' && m[i + word.length] !== '.') {
        const to = String(Number(word) + 1);
        add(i, word, to, `replaced literal ${word} with ${to}`);
      }
      i += word.length;
      continue;
    }
    if (m[i] === '<' && /\w/.test(m[i - 1] ?? '')) {
      const g = GENERIC.exec(m.slice(i));
      if (g) {
        i += g[0].length;
        continue;
      }
    }
    const op = OPS.find((t) => m.startsWith(t, i));
    if (!op) {
      i++;
      continue;
    }
    const to = SWAP[op];
    if (to) add(i, op, to, `replaced '${op}' with '${to}'`);
    i += op.length;
  }
  const ret = /^(\s*return\s+)(.*?)\s*;?\s*$/.exec(m);
  if (ret?.[2]) {
    const col = ret[1]!.length;
    const from = o.slice(col, col + ret[2].length);
    const zero = ZERO[lang];
    if (from !== zero) add(col, from, zero, `replaced 'return ${from}' with 'return ${zero}'`);
  }
  return res;
}

/** New-side line numbers from `git diff -U0` output; null when there are no hunks (e.g. untracked). */
export function parseHunks(diff: string): Set<number> | null {
  const lines = new Set<number>();
  let any = false;
  for (const h of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    any = true;
    const start = Number(h[1]);
    const count = h[2] === undefined ? 1 : Number(h[2]);
    for (let n = start; n < start + count; n++) lines.add(n);
  }
  return any ? lines : null;
}

function git(root: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

/** Spread picks: across files round-robin, and within a file across lines before reusing a line. */
export function spread(perFile: Mutant[][]): Mutant[] {
  const interleave = (groups: Mutant[][]) => {
    const out: Mutant[] = [];
    const n = Math.max(0, ...groups.map((g) => g.length));
    for (let r = 0; r < n; r++) for (const g of groups) if (r < g.length) out.push(g[r]!);
    return out;
  };
  return interleave(
    perFile.map((ms) => {
      const byLine = new Map<number, Mutant[]>();
      for (const mu of ms) byLine.set(mu.line, [...(byLine.get(mu.line) ?? []), mu]);
      return interleave([...byLine.values()]);
    }),
  );
}

const targetFile = (s: Spec) => s.target.split('::')[0]!.replace(/\\/g, '/');

async function candidates(root: string, files: string[], specs: Spec[], deps: Deps): Promise<Mutant[]> {
  const perFile: Mutant[][] = [];
  for (const file of files) {
    const src = await fs.readFile(path.join(root, file), 'utf8').catch(() => null);
    if (src === null) continue;
    const lang = specs.find((s) => targetFile(s) === file)!.lang;
    const diff = await git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD', '--', file]);
    const changedLines = diff === null ? null : parseHunks(diff);
    const orig = src.split('\n');
    const masked = mask(src, lang, deps.lineComment(lang)).split('\n');
    const ms: Mutant[] = [];
    orig.forEach((o, idx) => {
      const m = masked[idx]!;
      if ((changedLines && !changedLines.has(idx + 1)) || !m.trim() || IMPORT.test(o)) return;
      ms.push(...lineMutants(file, idx + 1, o, m, lang));
    });
    perFile.push(ms);
  }
  return spread(perFile);
}

export async function mutationCheck(
  root: string,
  specs: Spec[],
  changed: string[],
  config: Config,
  deadline: number,
  deps: Deps,
): Promise<DeepReport['mutation']> {
  const start = Date.now();
  const changedSet = new Set(changed.map((f) => f.replace(/\\/g, '/')));
  const files = [...new Set(specs.map(targetFile))].filter((f) => changedSet.has(f));
  if (!files.length) return undefined;
  const pool = await candidates(root, files, specs, deps);
  const result = { caught: 0, total: 0, survivors: [] as { file: string; line: number; desc: string }[], durationMs: 0 };
  if (pool.length) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'truthgate-mut-'));
    try {
      await fs.cp(root, tmp, { recursive: true, filter: (src) => src === root || !EXCLUDE.has(path.basename(src)) });
      for (const mu of pool) {
        if (result.total >= MAX_MUTANTS || Date.now() >= deadline) break;
        const abs = path.join(tmp, mu.file);
        const original = await fs.readFile(abs, 'utf8');
        const lines = original.split('\n');
        const l = lines[mu.line - 1]!;
        lines[mu.line - 1] = l.slice(0, mu.col) + mu.to + l.slice(mu.col + mu.from.length);
        await fs.writeFile(abs, lines.join('\n'));
        let caught = false;
        let ran = false;
        try {
          for (const s of specs.filter((sp) => targetFile(sp) === mu.file)) {
            const vs = await deps.runSpec(s, tmp, { seed: config.seed, runs: MUTANT_RUNS, deadline, config });
            ran ||= vs.some((v) => v.kind !== 'UNVERIFIED');
            if (vs.some((v) => v.kind === 'FALSIFIED')) {
              caught = true;
              break;
            }
          }
        } finally {
          await fs.writeFile(abs, original);
        }
        // ponytail: a mutant nothing could run (doesn't compile, shim error, timeout) proves nothing either way.
        if (!caught && !ran) continue;
        result.total++;
        if (caught) result.caught++;
        else result.survivors.push({ file: mu.file, line: mu.line, desc: mu.desc });
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  result.durationMs = Date.now() - start;
  return result;
}
