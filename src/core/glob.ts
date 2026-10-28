// Glob -> RegExp for forward-slash paths: `**` (any dirs), `*`, `?`, `{a,b}`.
// ponytail: no character classes or escapes; add them if a glob ever needs one.
const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  let re = cache.get(glob);
  if (re) return re;
  let s = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        s += '(?:.*/)?';
      } else s += '.*';
    } else if (c === '*') s += '[^/]*';
    else if (c === '?') s += '[^/]';
    else if (c === '{') {
      braces++;
      s += '(?:';
    } else if (c === '}' && braces) {
      braces--;
      s += ')';
    } else if (c === ',' && braces) s += '|';
    else s += c.replace(/[.+^$|()[\]{}\\]/g, '\\$&');
  }
  re = new RegExp(`^${s}$`);
  cache.set(glob, re);
  return re;
}

export const matchesAny = (file: string, globs: string[]) => globs.some((g) => globToRegExp(g).test(file));
