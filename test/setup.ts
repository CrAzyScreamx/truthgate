// Loaded with --import for every test run: keep baseline records out of the real ~/.truthgate.
// Child processes (CLI, hook, shims) inherit it through the environment.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TRUTHGATE_HOME ??= mkdtempSync(join(tmpdir(), 'tg-home-'));

// Temp test repos must commit without the developer's signing setup (e.g. 1Password SSH signing).
Object.assign(process.env, {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'tag.gpgsign',
  GIT_CONFIG_VALUE_1: 'false',
});
