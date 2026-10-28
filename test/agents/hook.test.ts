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
  assert.match(JSON.parse(capped.stdout).systemMessage, /STILL FAILING/);
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

test('bad stdin is tolerated; internal errors allow the stop', async () => {
  const { d } = deps([true]);
  assert.equal(decision((await runHookWith(claude, 'not json', '.', d)).stdout), 'block');
  const broken: HookDeps = { ...d, verify: async () => { throw new Error('boom'); } };
  assert.deepEqual(await runHookWith(claude, '{}', '.', broken), { stdout: '', exitCode: 0 });
});

test('stray console.log during verify does not reach the returned stdout', async () => {
  const { d } = deps([false]);
  const noisy: HookDeps = { ...d, verify: async (r, o) => { console.log('noise'); return d.verify(r, o); } };
  const r = await runHookWith(installers.gemini, '{}', '.', noisy);
  assert.equal(r.stdout, '{"decision":"allow"}\n');
});
