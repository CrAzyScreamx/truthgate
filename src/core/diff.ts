import { execFile } from 'node:child_process';

export class NotGitError extends Error {
  constructor(root: string) {
    super(`${root} is not inside a git work tree`);
    this.name = 'NotGitError';
  }
}

export function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stderr })) : resolve(stdout),
    ),
  );
}

/** Full sha of `rev` if it names a commit, else undefined. */
export const commitOf = (root: string, rev: string) =>
  rev ? git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).then((s) => s.trim() || undefined, () => undefined) : Promise.resolve(undefined);

/** Content of `file` (relative to root) at commit `rev`, or undefined if it is not there (or `rev` is ''). */
export const showAt = (root: string, rev: string, file: string) =>
  rev ? git(root, ['show', `${rev}:./${file}`]).then((s) => s, () => undefined) : Promise.resolve(undefined);

/** Working tree + staged vs `base` (default HEAD), plus untracked files; every file when `base` is
 *  not a commit (e.g. no commits yet). Paths are relative to root, forward slashes. Deleted files are
 *  included. `--no-renames` keeps a renamed file's old path in the list, so tamper sees it. */
export async function changedFiles(root: string, base = 'HEAD'): Promise<string[]> {
  try {
    await git(root, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    throw new NotGitError(root);
  }
  const sha = await commitOf(root, base);
  const lists = sha
    ? [
        ['diff', '--name-only', '--no-renames', '-z', '--relative', sha],
        ['diff', '--name-only', '--no-renames', '-z', '--relative', '--cached', sha],
        ['ls-files', '--others', '--exclude-standard', '-z'],
      ]
    : [
        ['ls-files', '-z'],
        ['ls-files', '--others', '--exclude-standard', '-z'],
      ];
  const out = await Promise.all(lists.map((a) => git(root, ['-c', 'core.quotepath=off', ...a])));
  return [...new Set(out.flatMap((s) => s.split('\0')).filter(Boolean))].sort();
}

/** Working tree differs from HEAD (tracked changes or untracked files), ignoring `except` paths. */
export const isDirty = async (root: string, except: string[] = []) => (await changedFiles(root)).some((f) => !except.includes(f));
