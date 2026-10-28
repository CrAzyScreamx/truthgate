import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { LanguageAdapter } from '../../contract.ts';
import { exec, probe } from '../../runner/proc.ts';
import { openShim } from '../../runner/shim.ts';
import { buildThenRun, bundledTemplate, genericShim, SetupError, shimCommand, splitTarget } from '../common.ts';

const SAVED = '.truthgate/shims/TruthgateShim.cs';

/** Nearest *.csproj from the target's directory up to the root. */
function findCsproj(root: string, file: string): string | undefined {
  for (let d = dirname(resolve(root, file)); ; d = dirname(d)) {
    const p = readdirSync(d).find((f) => f.endsWith('.csproj'));
    if (p) return join(d, p);
    if (d === resolve(root) || dirname(d) === d) return undefined;
  }
}

const shimProject = (tfm: string, shim: string, csproj: string) => `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>${tfm}</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="${shim}" />
    <ProjectReference Include="${csproj}" />
  </ItemGroup>
</Project>
`;

export const csharpAdapter: LanguageAdapter = {
  lang: 'csharp',
  available: (root) => probe(['dotnet', '--version'], 'dotnet', root),
  async open(spec, root) {
    const { file, name } = splitTarget(spec);
    const csproj = findCsproj(root, file);
    if (!csproj) throw new SetupError(`no .csproj found above ${file}`);
    const asmName = /<AssemblyName>\s*([^<]+?)\s*<\/AssemblyName>/.exec(await readFile(csproj, 'utf8'))?.[1] ?? basename(csproj, '.csproj');
    const env = { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', TRUTHGATE_ASSEMBLY: asmName, TRUTHGATE_CLASS: spec.kind === 'sequence' ? name : basename(file, '.cs') };
    const shim = genericShim(root, SAVED, 'csharp', 'TruthgateShim.cs');
    if (spec.shim) {
      const { command, cwd } = shimCommand(spec, root, shim, []);
      return openShim(command, cwd, { env });
    }
    // Stable temp dir per (csproj, shim) so rebuilds are incremental.
    const v = await exec(['dotnet', '--version'], { env });
    const tfm = `net${v.stdout.trim().split('.')[0]}.0`;
    const dir = join(tmpdir(), 'truthgate-cs', createHash('sha1').update(`${csproj}|${shim}`).digest('hex').slice(0, 12));
    const proj = join(dir, 'TruthgateShim.csproj');
    const xml = shimProject(tfm, shim, csproj);
    await mkdir(dir, { recursive: true });
    if (!existsSync(proj) || (await readFile(proj, 'utf8')) !== xml) await writeFile(proj, xml);
    const out = join(dir, 'out');
    const build = ['dotnet', 'build', proj, '-o', out, '-nologo', '-v', 'q', '-clp:ErrorsOnly'];
    return buildThenRun(build, root, () => ['dotnet', join(out, 'TruthgateShim.dll')], { env, what: 'dotnet build' });
  },
  shimTemplate: () => ({ path: SAVED, source: readFileSync(bundledTemplate('csharp', 'TruthgateShim.cs'), 'utf8') }),
  testFileGlobs: ['**/*Tests.cs', '**/*Test.cs', '**/*.Tests/**/*.cs'],
  skipMarkers: [/\[\s*\w*(Fact|Theory|Test\w*)\s*\([^)]*\bSkip\s*=/, /[\[,]\s*(Ignore|Explicit)\b/, /\bAssert\.(Ignore|Inconclusive)\s*\(/, /\bSkip\.(If|Unless)\s*\(/],
  assertPatterns: [/\bAssert\.\w+\s*\(/, /\.Should\(\)/],
  lineComment: '//',
};
