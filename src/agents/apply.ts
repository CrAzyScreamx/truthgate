// Writes installer FileChanges: create (never overwrite), merge (JSON/TOML), append-block.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, extname, basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import type { FileChange } from '../contract.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep-merge `add` into `base` in place. Objects recurse, arrays append missing items, existing
 *  scalars win (never clobber a user value). An existing `truthgate` entry is the user's and is left
 *  whole (merging into it would splice our args into their command); it is reported in `kept`. */
export function mergeInto(base: Obj, add: Obj, prefix = ''): { added: string[]; kept: string[] } {
  const added: string[] = [];
  const kept: string[] = [];
  for (const [k, v] of Object.entries(add)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const cur = base[k];
    if (cur === undefined) {
      base[k] = v;
      added.push(path);
    } else if (k === 'truthgate') {
      if (!isDeepStrictEqual(cur, v)) kept.push(path);
    } else if (isObj(cur) && isObj(v)) {
      const r = mergeInto(cur, v, path);
      added.push(...r.added);
      kept.push(...r.kept);
    } else if (Array.isArray(cur) && Array.isArray(v)) {
      const seen = new Set(cur.map((x) => JSON.stringify(x)));
      for (const item of v) {
        if (!seen.has(JSON.stringify(item))) {
          cur.push(item);
          added.push(`${path}[]`);
        }
      }
    }
  }
  return { added, kept };
}

const hashComment = new Set(['.toml', '.sh', '.yaml', '.yml', '']);
const BEGIN = 'truthgate:begin';
const END = 'truthgate:end';

/** Insert or replace the truthgate block. Hash-comment markers for TOML/sh/hook files, HTML otherwise. */
export function upsertBlock(existing: string, content: string, file: string): string {
  const hash = hashComment.has(extname(file)) || basename(file).startsWith('pre-');
  const [b, e] = hash ? [`# ${BEGIN}`, `# ${END}`] : [`<!-- ${BEGIN} -->`, `<!-- ${END} -->`];
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const block = [b, ...content.replace(/\r?\n$/, '').split(/\r?\n/), e].join(eol);
  const start = existing.indexOf(b);
  const stop = existing.indexOf(e, start);
  if (start >= 0 && stop > start) return existing.slice(0, start) + block + existing.slice(stop + e.length);
  if (existing === '') return block + eol;
  // A shebang must stay first; put the block right after it so a trailing `exit` can't skip it.
  if (existing.startsWith('#!')) {
    const nl = existing.indexOf('\n');
    if (nl < 0) return existing + eol + block + eol;
    return existing.slice(0, nl + 1) + block + eol + existing.slice(nl + 1);
  }
  return existing.replace(/(\r?\n)*$/, '') + eol + eol + block + eol;
}

function mergeText(path: string, existing: string | undefined, content: string): { text: string; added: string[]; kept: string[] } {
  const toml = extname(path) === '.toml';
  const parse = (s: string): Obj => (toml ? (parseToml(s) as Obj) : (JSON.parse(s) as Obj));
  const base = existing?.trim() ? parse(existing) : {};
  if (!isObj(base)) throw new Error('top level is not an object');
  const r = mergeInto(base, parse(content));
  if (!toml) return { text: JSON.stringify(base, null, 2) + '\n', ...r };
  if (!existing?.trim()) return { text: content.trim() + '\n', ...r };
  // TOML is only ever appended to (re-stringifying would drop the user's comments and layout), and
  // only when the result parses to exactly the merged document, i.e. our tables don't overlap theirs.
  const appended = existing.replace(/(\r?\n)*$/, '') + '\n\n' + content.trim() + '\n';
  let ok = false;
  try {
    ok = isDeepStrictEqual(parse(appended), base);
  } catch {
    // overlapping tables
  }
  if (r.added.length && !ok) throw new Error('our tables overlap existing ones');
  return { text: appended, ...r };
}

async function readOr(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Apply (or with dryRun, only describe) the changes. Returns one human-readable line per change. */
export async function applyChanges(root: string, changes: FileChange[], dryRun: boolean): Promise<string[]> {
  const lines: string[] = [];
  const verb = (v: string) => (dryRun ? `would ${v}` : v);
  for (const c of changes) {
    const file = join(root, c.path);
    const existing = await readOr(file);
    let next: string;
    let line: string;
    if (c.action === 'create') {
      if (existing !== undefined) {
        const same = existing.replace(/\r\n/g, '\n') === c.content.replace(/\r\n/g, '\n');
        const note = c.note && !same ? ` - ${c.note}` : '';
        lines.push(same ? `skip ${c.path} (up to date)` : `skip ${c.path} (exists and differs; not overwritten)${note}`);
        continue;
      }
      next = c.content;
      line = `${verb('create')} ${c.path}`;
    } else if (c.action === 'merge') {
      let r;
      try {
        r = mergeText(c.path, existing, c.content);
      } catch (e) {
        lines.push(`skip ${c.path} (${(e as Error).message}; merge by hand:\n${c.content.trim()})`);
        continue;
      }
      const kept = r.kept.length ? `kept your existing ${r.kept.join(', ')}; merge by hand if needed:\n${c.content.trim()}` : '';
      if (r.added.length === 0) {
        lines.push(kept ? `skip ${c.path} (${kept})` : `skip ${c.path} (up to date)`);
        continue;
      }
      next = r.text;
      line = `${verb(existing === undefined ? 'create' : 'merge')} ${c.path} (+${[...new Set(r.added)].join(', +')})`;
      if (kept) line += ` (${kept})`;
    } else {
      next = upsertBlock(existing ?? '', c.content, c.path);
      if (next === existing) {
        lines.push(`skip ${c.path} (up to date)`);
        continue;
      }
      line = `${verb(existing === undefined ? 'create' : 'update')} ${c.path} (truthgate block)`;
    }
    if (c.note) line += ` - ${c.note}`;
    lines.push(line);
    if (dryRun) continue;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, next, next.startsWith('#!') ? { mode: 0o755 } : {});
  }
  return lines;
}
