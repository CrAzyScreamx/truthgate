import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Config, State } from '../../src/contract.ts';
import { runHookWith, type HookDeps } from '../../src/agents/hook.ts';
import { installers } from '../../src/agents/index.ts';
import { report } from './report.ts';

function deps(blocking: boolean[], start = 0) {
  const state: State = { consecutiveBlocks: start };
  let i = 0;
  const d: HookDeps = {
    verify: async () => report(blocking[i++] ?? false),
    loadConfig: async () => ({ loopCap: 3 }) as Config,
    readState: async () => ({ ...state }),
    writeState: async (_r, s) => void Object.assign(state, s),
  };
  return { d, state };
}

const claude = installers.claude;
const decision = (s: string) => (s ? JSON.parse(s).decision : undefined);

test('blocks up to the loop cap, then allows with a capped message and resets', async () => {
  const { d, state } = deps([true, true, true, true, true]);
  const payload = JSON.stringify({ stop_hook_active: true, unknown: 1 });
  for (let n = 1; n <= 3; n++) {
    assert.equal(decision((await runHookWith(claude, payload, '.', d)).stdout), 'block');
    assert.equal(state.consecutiveBlocks, n);
  }
  const capped = await runHookWith(claude, payload, '.', d);
  assert.match(JSON.parse(capped.stdout).systemMessage, /STOP ALLOWED WITHOUT A PASSING VERIFY[\s\S]*FALSIFIED[\s\S]*loop cap reached: 3/);
  assert.equal(state.consecutiveBlocks, 0);
  assert.equal(decision((await runHookWith(claude, payload, '.', d)).stdout), 'block');
});

test('a pass resets the count', async () => {
  const { d, state } = deps([false], 2);
  const r = await runHookWith(claude, '{}', '.', d);
  assert.deepEqual(r, { stdout: '', exitCode: 0 });
  assert.equal(state.consecutiveBlocks, 0);
});

test('a fresh turn (stop_hook_active false / loop_count 0) starts a new chain', async () => {
  const { d, state } = deps([true, true], 3);
  assert.equal(decision((await runHookWith(claude, '{"stop_hook_active":false}', '.', d)).stdout), 'block');
  assert.equal(state.consecutiveBlocks, 1);
  state.consecutiveBlocks = 3;
  const r = await runHookWith(installers.cursor, '{"loop_count":0}', '.', d);
  assert.match(JSON.parse(r.stdout).followup_message, /FALSIFIED/);
});

test('bad stdin is tolerated; internal crashes allow the stop but say so', async () => {
  const { d } = deps([true]);
  assert.equal(decision((await runHookWith(claude, 'not json', '.', d)).stdout), 'block');
  const broken: HookDeps = { ...d, verify: async () => { throw new Error('boom'); } };
  const r = await runHookWith(claude, '{}', '.', broken);
  assert.equal(r.exitCode, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, undefined);
  assert.match(out.systemMessage, /internal error, stop allowed: boom/);
});

test('a spec error blocks with its text and counts toward the cap', async () => {
  const { d, state } = deps([]);
  const specErr = Object.assign(new Error('.truthgate/specs/zz.yaml: bogus: unknown field'), { name: 'SpecError' });
  const bad: HookDeps = { ...d, verify: async () => { throw specErr; } };
  const p = '{"stop_hook_active":true}';
  for (let n = 1; n <= 3; n++) {
    const out = JSON.parse((await runHookWith(claude, p, '.', bad)).stdout);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /could not run: \.truthgate\/specs\/zz\.yaml: bogus: unknown field/);
    assert.equal(state.consecutiveBlocks, n);
  }
  assert.match(JSON.parse((await runHookWith(claude, p, '.', bad)).stdout).systemMessage, /STOP ALLOWED/);
});

test('a config error blocks (default loop cap applies)', async () => {
  const { d, state } = deps([]);
  const bad: HookDeps = { ...d, loadConfig: async () => { throw new Error('.truthgate/config.json: loopCap has the wrong type'); } };
  const out = JSON.parse((await runHookWith(installers.codex, '{}', '.', bad)).stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /config\.json: loopCap/);
  assert.equal(state.consecutiveBlocks, 1);
});

test('stray console.log during verify does not reach the returned stdout', async () => {
  const { d } = deps([false]);
  const noisy: HookDeps = { ...d, verify: async (r, o) => { console.log('noise'); return d.verify(r, o); } };
  const r = await runHookWith(installers.gemini, '{}', '.', noisy);
  assert.equal(r.stdout, '{"decision":"allow"}\n');
});
