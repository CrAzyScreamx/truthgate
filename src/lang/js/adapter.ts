import type { Lang, LanguageAdapter } from '../../contract.ts';
import { openShim } from '../../runner/shim.ts';
import { bundledTemplate, shimCommand } from '../common.ts';

/**
 * JS/TS runs in a child `node` process (Node 24 strips TS types natively) through the bundled generic shim,
 * so a hung target is killed at the deadline and every run imports fresh code. See the template header
 * for the calling convention and what counts as rejected.
 */
function jsAdapter(lang: Lang): LanguageAdapter {
  const exts = lang === 'ts' ? ['ts', 'tsx', 'mts', 'cts'] : ['js', 'mjs', 'cjs', 'jsx'];
  return {
    lang,
    available: async () => true,
    async open(spec, root) {
      const shim = bundledTemplate('js', 'truthgate_shim.mjs');
      const { command, cwd } = shimCommand(spec, root, shim, [process.execPath, shim]);
      return openShim(command, cwd, { env: { ...process.env, TRUTHGATE_ROOT: root, TRUTHGATE_TARGET: spec.target } });
    },
    shimTemplate: () => ({ path: '', source: `// ${lang}: no shim needed; truthgate runs the target in a child node process with its bundled shim.\n` }),
    testFileGlobs: exts.flatMap((e) => [`**/*.test.${e}`, `**/*.spec.${e}`, `**/__tests__/**/*.${e}`]),
    skipMarkers: [/\.skip(If)?\b/, /\.(only|todo)\s*\(/, /\bx(it|test|describe)\s*\(/, /\b(skip|only|todo):\s*true\b/],
    assertPatterns: [/\bexpect\s*\(/, /\bassert(\.\w+)?\s*\(/],
    lineComment: '//',
  };
}

export const tsAdapter = jsAdapter('ts');
export const jsAdapterJs = jsAdapter('js');
