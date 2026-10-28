import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageAdapter } from '../../contract.ts';
import { probe } from '../../runner/proc.ts';
import { openShim } from '../../runner/shim.ts';
import { bundledTemplate, genericShim, shimCommand } from '../common.ts';

const SAVED = '.truthgate/shims/truthgate_shim.py';

/** The project's python: `uv run python` with a uv.lock, a local .venv, else python/python3 on PATH. */
export function pythonCmd(root: string): string[] {
  if (existsSync(join(root, 'uv.lock'))) return ['uv', 'run', '--quiet', 'python'];
  const venv = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python');
  if (existsSync(venv)) return [venv];
  return [process.platform === 'win32' ? 'python' : 'python3'];
}

/** UTF-8 I/O on Windows, and no __pycache__ in the user's tree (it would show up as a change). */
export const pythonEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  PYTHONDONTWRITEBYTECODE: '1',
  ...extra,
});

export const pythonAdapter: LanguageAdapter = {
  lang: 'python',
  available: (root) => probe([...pythonCmd(root), '--version'], 'python', root),
  async open(spec, root) {
    const shim = genericShim(root, SAVED, 'python', 'truthgate_shim.py');
    const { command, cwd } = shimCommand(spec, root, shim, [...pythonCmd(root), shim]);
    return openShim(command, cwd, { env: pythonEnv({ TRUTHGATE_ROOT: root, TRUTHGATE_TARGET: spec.target }) });
  },
  shimTemplate: () => ({ path: SAVED, source: readFileSync(bundledTemplate('python', 'truthgate_shim.py'), 'utf8') }),
  testFileGlobs: ['**/test_*.py', '**/*_test.py'],
  skipMarkers: [/@pytest\.mark\.(skip|skipif|xfail)\b/, /\bpytest\.(skip|xfail)\s*\(/, /@unittest\.skip/],
  assertPatterns: [/\bassert\b/, /\bself\.assert\w*\s*\(/, /\bpytest\.raises\s*\(/],
  lineComment: '#',
};
