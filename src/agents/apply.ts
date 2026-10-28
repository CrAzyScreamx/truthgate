// Writes installer FileChanges: create (never overwrite), merge (JSON/TOML), append-block.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, extname, basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { FileChange } from '../contract.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep-merge `add` into `base` in place. Objects recurse, arrays append missing items, existing
 *  scalars win (never clobber a user value). Returns the dotted paths that were added. */
export function mergeInto(base: Obj, add: Obj, prefix = ''): string[] {
  const added: string[] = [];
  for (const [k, v] of Object.entries(add)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const cur = base[k];
    if (cur === undefined) {
      base[k] = v;
      added.push(path);
    } else if (isObj(cur) && isObj(v)) {
      added.push(...mergeInto(cur, v, path));
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
  return added;
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

function mergeText(path: string, existing: string | undefined, content: string): { text: string; added: string[] } {
  const toml = extname(path) === '.toml';
  const parse = (s: string): Obj => (toml ? (parseToml(s) as Obj) : (JSON.parse(s) as Obj));
  const base = existing?.trim() ? parse(existing) : {};
  if (!isObj(base)) throw new Error('top level is not an object');
  const added = mergeInto(base, parse(content));
  if (toml && existing?.trim()) {
    // Appending keeps the user's comments and layout; valid only when it parses to the merged result.
    const appended = existing.replace(/(\r?\n)*$/, '') + '\n\n' + content.trim() + '\n';
    try {
      if (isDeepStrictEqual(parse(appended), base)) return { text: appended, added };
    } catch {
      // overlapping tables: fall through to a full rewrite
    }
  }
  const text = toml ? stringifyToml(base) + '\n' : JSON.stringify(base, null, 2) + '\n';
  return { text, added };
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
        lines.push(same ? `skip ${c.path} (up to date)` : `skip ${c.path} (exists and differs; not overwritten)`);
        continue;
      }
      next = c.content;
      line = `${verb('create')} ${c.path}`;
    } else if (c.action === 'merge') {
      let r;
      try {
        r = mergeText(c.path, existing, c.content);
      } catch (e) {
        lines.push(`skip ${c.path} (cannot parse: ${(e as Error).message}; merge by hand:\n${c.content.trim()})`);
        continue;
      }
      if (r.added.length === 0) {
        lines.push(`skip ${c.path} (up to date)`);
        continue;
      }
      next = r.text;
      line = `${verb(existing === undefined ? 'create' : 'merge')} ${c.path} (+${[...new Set(r.added)].join(', +')})`;
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
