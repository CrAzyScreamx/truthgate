import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../contract.ts';

export const CONFIG_FILE = '.truthgate/config.json';

export const DEFAULT_CONFIG: Config = {
  budgetSeconds: 60,
  deepBudgetSeconds: 120,
  loopCap: 3,
  seed: 42,
  defaultRuns: 100,
  provers: {},
  python: { native: false },
  sourceGlobs: ['**/*.py', '**/*.ts', '**/*.js', '**/*.java', '**/*.cs', '**/*.go', '**/*.rs'],
};

/** Reads `.truthgate/config.json` (optional) over the defaults. Throws on bad JSON or wrong types. */
export async function loadConfig(root: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(join(root, CONFIG_FILE), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_CONFIG);
    throw e;
  }
  let raw: Partial<Config>;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${CONFIG_FILE}: ${(e as Error).message}`);
  }
  const c: Config = { ...structuredClone(DEFAULT_CONFIG), ...raw };
  c.provers = { ...raw.provers };
  c.python = { ...DEFAULT_CONFIG.python, ...raw.python };
  const bad = (f: string) => new Error(`${CONFIG_FILE}: ${f} has the wrong type`);
  for (const k of ['budgetSeconds', 'deepBudgetSeconds', 'loopCap', 'seed', 'defaultRuns'] as const)
    if (typeof c[k] !== 'number' || !(c[k] >= 0)) throw bad(k);
  if (typeof c.python.native !== 'boolean') throw bad('python.native');
  if (!Array.isArray(c.sourceGlobs) || !c.sourceGlobs.every((g) => typeof g === 'string')) throw bad('sourceGlobs');
  for (const [k, v] of Object.entries(c.provers)) if (typeof v !== 'string') throw bad(`provers.${k}`);
  return c;
}
