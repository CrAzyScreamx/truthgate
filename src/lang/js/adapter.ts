import type { Lang, LanguageAdapter } from '../../contract.ts';
import { openShim } from '../../runner/shim.ts';
import { bundledTemplate, shimCommand } from '../common.ts';

// Our own tsx (a dependency), not the project's: it compiles targets with the project's tsconfig.
const TSX = import.meta.resolve('tsx');

/**
 * JS/TS runs in a child `node` process under the tsx loader, through the bundled generic shim, so a hung
 * target is killed at the deadline and every run imports fresh code. Plain type stripping would reject
 * decorators, parameter properties, extensionless imports and tsconfig `paths`; tsx handles all of them.
 * See the template header for the calling convention and what counts as rejected.
 */
function jsAdapter(lang: Lang): LanguageAdapter {
  const exts = lang === 'ts' ? ['ts', 'tsx', 'mts', 'cts'] : ['js', 'mjs', 'cjs', 'jsx'];
  return {
    lang,
    available: async () => true,
    async open(spec, root) {
      const shim = bundledTemplate('js', 'truthgate_shim.mjs');
      const { command, cwd } = shimCommand(spec, root, shim, [process.execPath, '--import', TSX, shim]);
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
