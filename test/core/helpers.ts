import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function repo(files: Record<string, string> = {}, commit = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tg-git-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  g('config', 'core.autocrlf', 'false');
  for (const [f, c] of Object.entries(files)) {
    await mkdir(join(root, f, '..'), { recursive: true });
    await writeFile(join(root, f), c);
  }
  if (commit && Object.keys(files).length) {
    g('add', '-A');
    g('commit', '-qm', 'init');
  }
  return root;
}
export const put = async (root: string, f: string, c: string) => {
  await mkdir(join(root, f, '..'), { recursive: true });
  await writeFile(join(root, f), c);
};
