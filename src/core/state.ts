import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { State } from '../contract.ts';

const STATE_FILE = '.truthgate/state.json';

export async function readState(root: string): Promise<State> {
  try {
    const s = JSON.parse(await readFile(join(root, STATE_FILE), 'utf8')) as Partial<State>;
    return { ...s, consecutiveBlocks: Number.isInteger(s.consecutiveBlocks) ? s.consecutiveBlocks! : 0 };
  } catch {
    return { consecutiveBlocks: 0 }; // missing or corrupt: start over
  }
}

export async function writeState(root: string, s: State): Promise<void> {
  await mkdir(join(root, '.truthgate'), { recursive: true });
  await writeFile(join(root, STATE_FILE), JSON.stringify(s, null, 2) + '\n');
}
