import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
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

/** Pre-commit hook change: our block goes into an existing hook (never clobbered), or a new sh file. */
export async function installPreCommit(root: string): Promise<FileChange> {
  const file = join(await hooksDir(root), 'pre-commit');
  const path = relative(root, file).replaceAll('\\', '/');
  const exists = await access(file).then(() => true, () => false);
  return exists
    ? { path, action: 'append-block', content: VERIFY, note: 'pre-commit hook' }
    : { path, action: 'create', content: upsertBlock('#!/bin/sh\n', VERIFY, 'pre-commit'), note: 'pre-commit hook' };
}
