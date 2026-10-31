// Setup behind the bare `truthgate` command: writes skills, commands, rules, MCP and hooks for the chosen
// agents, into this repo or into the user's home (every project). The CLI asks the questions.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentId, FileChange } from './contract.ts';
import { CONFIG_FILE } from './core/config.ts';
import { readBaseline, writeBaseline } from './core/baseline.ts';
import { NotGitError } from './core/diff.ts';
import { applyChanges, installers, installPreCommit } from './agents/index.ts';
import { exec } from './runner/proc.ts';

export interface SetupIO {
  log(line: string): void;
  /** A yes/no question; `initial` is the suggested answer. */
  confirm(message: string, initial: boolean): Promise<boolean>;
  dryRun?: boolean;
}

const PY_MARKERS = new Set(['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile']);

/** A Python project (a packaging/requirements file), not just stray scripts in another stack's repo. */
async function hasPythonProject(dir: string, depth = 0): Promise<boolean> {
  if (depth > 6) return false;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isFile() && PY_MARKERS.has(e.name)) return true;
  for (const e of entries)
    if (e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'venv', 'target', 'dist', 'build'].includes(e.name) && (await hasPythonProject(join(dir, e.name), depth + 1)))
      return true;
  return false;
}

/** Install command for Hypothesis as a project dev dependency: uv, or the project's .venv. Never the system Python. */
async function hypothesisInstall(root: string): Promise<string[] | undefined> {
  if (existsSync(join(root, 'uv.lock'))) return ['uv', 'add', '--dev', 'hypothesis'];
  const py = (await import('./lang/python/adapter.ts')).pythonCmd(root);
  return ['python', 'python3'].includes(py[0]!) ? undefined : [...py, '-m', 'pip', 'install', 'hypothesis'];
}

/** Only called to turn the native path on: false is the default, so writing it would just be a config change to commit. */
async function enablePythonNative(root: string) {
  const file = join(root, CONFIG_FILE);
  const cfg = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : {};
  cfg.python = { ...cfg.python, native: true };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cfg, null, 2) + '\n');
}

/** Set up `agents` in the repo at `root`. Returns the closing message. */
export async function setupProject(root: string, agents: AgentId[], io: SetupIO): Promise<string> {
  const { dryRun } = io;
  const changes: FileChange[] = [{ path: '.truthgate/.gitignore', action: 'create', content: 'state.json\nlast-run.json\n' }];
  for (const a of agents) changes.push(...(await installers[a].plan(root)));

  const install = (await hasPythonProject(root)) ? ((await hypothesisInstall(root)) ?? null) : undefined;
  const hypothesis = !!install && (await io.confirm(`Python project found. Add Hypothesis as a dev dependency (\`${install.join(' ')}\`) for native property tests?`, true));
  if (install === null)
    io.log(
      `Python project found, but no uv.lock or .venv to add Hypothesis to, so Python specs use the shim. For the native path, install hypothesis in the project's environment, set "python": {"native": true} in ${CONFIG_FILE} and commit it.`,
    );
  const instructOnly = agents.filter((a) => !installers[a].enforces);
  const hook = (await io.confirm('Install a git pre-commit hook that runs `truthgate verify`?', instructOnly.length > 0)) ? await installPreCommit(root) : undefined;
  if (hook) changes.push(hook);

  const applied = await applyChanges(root, changes, !!dryRun);
  for (const line of applied) io.log(line);
  // applyChanges reports one line per change, in order. The gate exists if the hook was (or would
  // be) written, or is already up to date; "skip … (exists and differs …)" means it is not there.
  const hookLine = hook ? applied[changes.indexOf(hook)] : undefined;
  const commitGate = !!hookLine && (!hookLine.startsWith('skip ') || hookLine.includes('(up to date)'));

  // verify reports any config change that isn't committed as tampering, so say so whenever we write it.
  const commitConfig = `commit ${CONFIG_FILE}, then run \`npx truthgate accept\` (verify reports config changes since the baseline as tampering)`;
  if (hypothesis && install) {
    if (dryRun) io.log(`would run: ${install.join(' ')}, then set python.native in ${CONFIG_FILE}; ${commitConfig}`);
    else {
      io.log(`running: ${install.join(' ')}`);
      const r = spawnSync(install[0]!, install.slice(1), { cwd: root, stdio: 'inherit' });
      if (r.status !== 0) io.log('Hypothesis install failed; Python specs will use the shim path.');
      else {
        await enablePythonNative(root);
        io.log(`Set python.native in ${CONFIG_FILE}: ${commitConfig}.`);
      }
    }
  }
  // Pin the baseline now: if the first verify recorded it, an agent's commits before that run would be in it.
  if (!dryRun) {
    const b = await readBaseline(root).catch((e) => (e instanceof NotGitError ? undefined : Promise.reject(e)));
    if (b?.source === 'head' && b.commit) {
      await writeBaseline(root, { commit: b.commit, source: 'auto' });
      io.log(`Recorded the truthgate baseline at ${b.commit.slice(0, 7)} (HEAD): tests and config are checked against it.`);
    }
  }
  for (const a of agents) for (const s of installers[a].manualSteps ?? []) io.log(`${a}: ${s}`);
  if (instructOnly.length)
    io.log(
      `${instructOnly.join(', ')}: instruct-only. No stop hook exists for ${instructOnly.length === 1 ? 'this agent' : 'these agents'}, so truthgate runs only when the agent follows its rules file${commitGate ? ' and at every commit (pre-commit hook)' : ''}.`,
    );
  return dryRun
    ? 'Dry run: nothing was written.'
    : 'Next: have the agent write specs in .truthgate/specs/ for the code it changes; `npx truthgate verify` checks them. To spec and check existing code, run the truthgate-review command in your agent.';
}

/** Agents with a user-level setup, and which of them are installed under `home`. */
export function globalAgents(home: string) {
  const supported = Object.values(installers).filter((i) => i.globalPlan).map((i) => i.id);
  return { supported, detected: supported.filter((a) => existsSync(join(home, installers[a].homeDir ?? `.${a}`))) };
}

/** Set up `agents` in the user-level config under `home`, for every project. Returns the closing message. */
export async function setupGlobal(home: string, agents: AgentId[], io: SetupIO): Promise<string> {
  const changes: FileChange[] = [];
  for (const a of agents) changes.push(...(await installers[a].globalPlan!()));
  io.log(`In ${home}:`);
  for (const line of await applyChanges(home, changes, !!io.dryRun)) io.log(line);
  for (const a of agents)
    for (const cmd of installers[a].globalExec ?? []) {
      // An agent's own CLI writes to the real home: run it only when that is the home being set up.
      if (io.dryRun || home !== homedir()) {
        io.log(`would run: ${cmd.join(' ')}`);
        continue;
      }
      const r = await exec(cmd, { timeoutMs: 60_000 });
      const why = (r.stderr || r.stdout || r.error || '').trim().split('\n')[0];
      io.log(r.code === 0 ? `ran: ${cmd.join(' ')}` : `${a}: \`${cmd.join(' ')}\` failed (${why || `exit ${r.code}`}); run it yourself if truthgate isn't registered yet`);
    }
  for (const a of agents) for (const s of installers[a].globalManualSteps ?? []) io.log(`${a}: ${s}`);
  return io.dryRun
    ? 'Dry run: nothing was written.'
    : 'Done. The global stop hooks act only in git repos with .truthgate/specs/. The git pre-commit hook is per project: run `npx truthgate` in a repo and pick "This project" to add it.';
}
