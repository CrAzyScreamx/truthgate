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

const hasHead = (root: string) => git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);

/** Content of `file` (relative to root) at HEAD, or undefined if it is not there (or there is no HEAD). */
export const showHead = (root: string, file: string) =>
  git(root, ['show', `HEAD:./${file}`]).then((s) => s, () => undefined);

/** Working tree + staged vs HEAD, plus untracked files; every file when the repo has no commits.
 *  Paths are relative to root, forward slashes. Deleted files are included. */
export async function changedFiles(root: string): Promise<string[]> {
  try {
    await git(root, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    throw new NotGitError(root);
  }
  const lists = (await hasHead(root))
    ? [
        ['diff', '--name-only', '-z', '--relative', 'HEAD'],
        ['diff', '--name-only', '-z', '--relative', '--cached', 'HEAD'],
        ['ls-files', '--others', '--exclude-standard', '-z'],
      ]
    : [
        ['ls-files', '-z'],
        ['ls-files', '--others', '--exclude-standard', '-z'],
      ];
  const out = await Promise.all(lists.map((a) => git(root, ['-c', 'core.quotepath=off', ...a])));
  return [...new Set(out.flatMap((s) => s.split('\0')).filter(Boolean))].sort();
}
