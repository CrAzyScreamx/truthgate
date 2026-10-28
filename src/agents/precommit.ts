import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { FileChange } from '../contract.ts';
import { upsertBlock } from './apply.ts';

const VERIFY = 'npx -y truthgate verify || exit 1';

/** `git rev-parse --git-path hooks` honours core.hooksPath and worktrees; `.git/hooks` if git fails. */
async function hooksDir(root: string): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root });
    const dir = stdout.trim();
    return isAbsolute(dir) ? dir : join(root, dir);
  } catch {
    return join(root, '.git', 'hooks');
  }
}

/** Shebang-less hooks run under git's sh, so only sh-family or shebang-less hooks can take our block. */
const shHook = (text: string) => !text.startsWith('#!') || /^#!\S*\/(env\s+)?(sh|bash|zsh|dash)\b/.test(text);

/** Pre-commit hook change: our block goes into an existing sh hook (never clobbered), or a new sh file.
 *  A hook in another language yields a `create` that apply refuses, printing the manual step as its note. */
export async function installPreCommit(root: string): Promise<FileChange> {
  const file = join(await hooksDir(root), 'pre-commit');
  const path = relative(root, file).replaceAll('\\', '/');
  const fresh = upsertBlock('#!/bin/sh\n', VERIFY, 'pre-commit');
  const existing = await readFile(file, 'utf8').catch(() => undefined);
  if (existing === undefined) return { path, action: 'create', content: fresh, note: 'pre-commit hook' };
  if (shHook(existing)) return { path, action: 'append-block', content: VERIFY, note: 'pre-commit hook' };
  return { path, action: 'create', content: fresh, note: `existing hook is not sh: add \`${VERIFY}\` (or its equivalent) to it by hand` };
}
