import { mkdtemp, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { LanguageAdapter } from '../../contract.ts';
import { probe } from '../../runner/proc.ts';
import { openShim } from '../../runner/shim.ts';
import { buildThenRun, bundledTemplate, genericShim, shimCommand, splitTarget } from '../common.ts';

const SAVED = '.truthgate/shims/TruthgateShim.java';

export const javaAdapter: LanguageAdapter = {
  lang: 'java',
  available: async (root) => {
    const java = await probe(['java', '-version'], 'java', root);
    return java === true ? probe(['javac', '-version'], 'javac', root) : java;
  },
  async open(spec, root) {
    const { file, name } = splitTarget(spec);
    const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(await readFile(join(root, file), 'utf8'))?.[1];
    // function specs: the class is the file's class; sequence specs: the target names the class.
    const cls = spec.kind === 'sequence' ? name : basename(file, '.java');
    const env = { ...process.env, TRUTHGATE_CLASS: pkg ? `${pkg}.${cls}` : cls };
    const shim = genericShim(root, SAVED, 'java', 'TruthgateShim.java');
    if (spec.shim) {
      const { command, cwd } = shimCommand(spec, root, shim, []);
      return openShim(command, cwd, { env });
    }
    // Compile the working tree's source (never stale build output) into a temp dir.
    const out = await mkdtemp(join(tmpdir(), 'truthgate-java-'));
    const srcRoot = join(root, dirname(file), ...(pkg?.split('.').map(() => '..') ?? []));
    const javac = ['javac', '-encoding', 'UTF-8', '-nowarn', '-d', out, '-sourcepath', srcRoot, join(root, file)];
    return buildThenRun(javac, root, () => ['java', '-cp', out, shim], { tmp: out, env, what: 'javac' });
  },
  shimTemplate: () => ({ path: SAVED, source: readFileSync(bundledTemplate('java', 'TruthgateShim.java'), 'utf8') }),
  testFileGlobs: ['**/src/test/**/*.java', '**/*Test.java', '**/*Tests.java'],
  skipMarkers: [/@Disabled\w*/, /@Ignore\b/, /\bassume(True|That)\s*\(\s*false\b/, /\bassumeFalse\s*\(\s*true\b/, /\bAssumptions\.abort\s*\(/],
  assertPatterns: [/\bassert\w*\s*\(/, /^\s*assert\s/, /\bverify\s*\(/],
  lineComment: '//',
};
