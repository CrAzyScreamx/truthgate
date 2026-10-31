#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as clack from '@clack/prompts';
import type { AgentId, Spec } from './contract.ts';
import { CONFIG_FILE } from './core/config.ts';
import { loadSpecs, SpecError } from './core/spec.ts';
import { readBaseline, writeBaseline } from './core/baseline.ts';
import { changedFiles, commitOf, isDirty, NotGitError } from './core/diff.ts';
import { checkConfig, detectTamper, specChanges } from './core/tamper.ts';
import { OWN_FILES, verify } from './core/verify.ts';
import { formatReport } from './core/report.ts';

const USAGE = `usage: truthgate [command]
  (none, in a terminal)                        set up: this project or globally, then pick agents
  verify [--deep] [--all] [--json] [--budget <s>]
  accept                                       accept intentional test/config changes (baseline = HEAD)
  status                                       list specs, the baseline, and changes since it
  shim <spec-id> [--force]                     write the shim template for a spec
  hook --agent <id> [--global]                 stop-hook entry point (reads stdin)
  mcp                                          MCP server on stdio`;

const AGENTS: AgentId[] = ['claude', 'codex', 'gemini', 'copilot', 'cursor', 'amp', 'windsurf', 'opencode', 'cline', 'kiro'];
const VALUE_FLAGS = new Set(['agent', 'budget']);
const BOOL_FLAGS = new Set(['deep', 'all', 'json', 'force', 'help', 'global']);

class UsageError extends Error {}

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h') (flags.help ??= []).push('');
    else if (!a.startsWith('--')) pos.push(a);
    else {
      const eq = a.indexOf('=');
      const k = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (VALUE_FLAGS.has(k)) {
        const v = eq < 0 ? argv[++i] : a.slice(eq + 1);
        if (v === undefined || v === '') throw new UsageError(`--${k} needs a value`);
        (flags[k] ??= []).push(v);
      } else if (BOOL_FLAGS.has(k) && eq < 0) (flags[k] ??= []).push('');
      else throw new UsageError(`unknown option ${a}`);
    }
  }
  return { pos, flags, has: (k: string) => k in flags };
}

class Cancelled extends Error {}

/** Unwrap a clack prompt result; Esc / Ctrl+C aborts setup. */
async function answer<T>(r: Promise<T>): Promise<Exclude<T, symbol>> {
  const v = await r;
  if (clack.isCancel(v)) throw new Cancelled();
  return v as Exclude<T, symbol>;
}

/** Bare `truthgate` in a terminal: where (this project / every project), which agents, then install. */
async function setup(root: string): Promise<number> {
  const { setupProject, setupGlobal, globalAgents } = await import('./setup.ts');
  const { installers } = await import('./agents/index.ts');
  clack.intro(' truthgate ');
  try {
    const scope = await answer(clack.select({
      message: 'Where should truthgate be set up?',
      options: [
        { value: 'project', label: 'This project', hint: root },
        { value: 'global', label: 'Globally', hint: 'every project, in your user-level agent config' },
      ],
    }));
    const home = homedir();
    const { supported, detected } = globalAgents(home);
    const choices = scope === 'global' ? supported : AGENTS;
    const agents = await answer(clack.multiselect<AgentId>({
      message: 'Which coding agents should truthgate set up?',
      options: choices.map((a) => ({ value: a, label: a, hint: installers[a].enforces ? 'stop hook' : 'instruct-only' })),
      initialValues: scope === 'global' ? detected : [],
    }));
    const io = { log: (s: string) => console.log(s), confirm: (message: string, initialValue: boolean) => answer(clack.confirm({ message, initialValue })) };
    clack.outro(scope === 'global' ? await setupGlobal(home, agents, io) : await setupProject(root, agents, io));
    return 0;
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    clack.cancel('Setup cancelled; nothing was written.');
    return 1;
  }
}

/** Test/config tamper findings and spec edits since `base`, working tree included. */
async function drift(root: string, specs: Spec[], base: string) {
  const changed = await changedFiles(root, base);
  return {
    tamper: [...(await detectTamper(root, changed, undefined, base)), ...(await checkConfig(root, base))],
    edits: await specChanges(root, specs, changed, base),
  };
}

async function status(root: string): Promise<number> {
  const specs = await loadSpecs(root);
  if (specs.length === 0) console.log('No specs in .truthgate/specs/.');
  const w = Math.max(...specs.map((s) => s.id.length), 2);
  for (const s of specs) console.log(`${s.id.padEnd(w)}  ${s.kind.padEnd(8)}  ${s.target}`);
  let b: Awaited<ReturnType<typeof readBaseline>>;
  try {
    b = await readBaseline(root);
  } catch (e) {
    if (e instanceof NotGitError) return console.log('Not a git repository: no baseline, tamper checks skipped.'), 0;
    throw e;
  }
  if (b.source === 'head') return console.log('Baseline: none recorded yet; the first `verify` records HEAD.'), 0;
  console.log(`Baseline: ${b.commit.slice(0, 7)} (${b.source}).`);
  const { tamper, edits } = await drift(root, specs, b.commit);
  for (const f of tamper) console.log(`TAMPER     ${f.rule}  ${f.file}  ${f.detail}`);
  for (const c of edits) console.log(`SPEC EDIT  ${c}`);
  return 0;
}

/** The user's sign-off on intentional test/config changes: move the baseline to HEAD. */
async function accept(root: string): Promise<number> {
  const head = await commitOf(root, 'HEAD');
  if (!head) throw new UsageError('accept records HEAD as the baseline, and this repo has no commits yet');
  const old = await readBaseline(root);
  if (old.source !== 'head' && old.commit !== head) {
    const { tamper, edits } = await drift(root, await loadSpecs(root), old.commit);
    if (tamper.length || edits.length) console.log(`Accepting these changes since ${old.commit.slice(0, 7)}:`);
    for (const f of tamper) console.log(`  ${f.rule}: ${f.file}${f.line ? `:${f.line}` : ''} (${f.detail})`);
    for (const c of edits) console.log(`  ${c}`);
  }
  if (await isDirty(root, OWN_FILES)) console.log('Uncommitted changes are not accepted: accept records HEAD. Commit them, then run accept again.');
  await writeBaseline(root, { commit: head, source: 'accept' });
  console.log(`Baseline set to ${head.slice(0, 7)} (HEAD): truthgate now checks tests and config against this commit.`);
  return 0;
}

async function shim(root: string, args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.pos[1];
  if (!id) throw new UsageError('shim needs a spec id');
  const spec = (await loadSpecs(root)).find((s) => s.id === id);
  if (!spec) throw new UsageError(`no spec with id "${id}"`);
  const { getAdapter } = await import('./lang/index.ts');
  const t = getAdapter(spec.lang).shimTemplate(spec, root);
  if (!t.path) {
    console.log(t.source.trim());
    return 0;
  }
  const file = join(root, t.path);
  if (existsSync(file) && !args.has('force')) {
    console.log(`${t.path} already exists; not overwritten (use --force to replace it).`);
    return 0;
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, t.source);
  console.log(`wrote ${t.path}. Fill in the marked parts so it calls ${spec.target}.`);
  return 0;
}

async function readStdin(): Promise<string> {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cmd = args.pos[0];
  const root = process.cwd();
  // Bare `truthgate` / `npx truthgate` in a terminal is setup: one step from nothing to configured.
  if (!cmd && !args.has('help') && process.stdin.isTTY && process.stdout.isTTY) return setup(root);
  if (args.has('help') || !cmd) {
    console.log(USAGE);
    return cmd || args.has('help') ? 0 : 2;
  }
  switch (cmd) {
    case 'verify': {
      const budget = args.flags.budget?.at(-1);
      const budgetSeconds = budget === undefined ? undefined : Number(budget);
      if (budgetSeconds !== undefined && !(budgetSeconds > 0)) throw new UsageError('--budget must be a positive number of seconds');
      const r = await verify(root, { deep: args.has('deep'), all: args.has('all'), budgetSeconds });
      console.log(args.has('json') ? JSON.stringify(r, null, 2) : formatReport(r));
      return r.blocking ? 1 : 0;
    }
    case 'accept':
      return accept(root);
    case 'status':
      return status(root);
    case 'shim':
      return shim(root, args);
    case 'hook': {
      const agent = args.flags.agent?.[0] as AgentId | undefined;
      if (!agent || !AGENTS.includes(agent)) throw new UsageError(`hook needs --agent <${AGENTS.join('|')}>`);
      const { runHook } = await import('./agents/index.ts');
      const r = await runHook(agent, await readStdin(), root, args.has('global'));
      process.stdout.write(r.stdout);
      return r.exitCode;
    }
    case 'mcp':
      await (await import('./mcp/server.ts')).startMcp(root);
      return -1; // keep serving; the transport owns the process lifetime
    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code;
  },
  (e: unknown) => {
    const known = e instanceof UsageError || e instanceof SpecError || e instanceof NotGitError || (e instanceof Error && e.message.includes(CONFIG_FILE));
    process.stderr.write(`truthgate: ${known ? (e as Error).message : ((e as Error)?.stack ?? String(e))}\n`);
    if (e instanceof UsageError) process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
  },
);
