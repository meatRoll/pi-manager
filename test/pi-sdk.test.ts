import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-sdk-')));
after(() => rm(temp, { recursive: true, force: true }));

test('findPiSdk discovers a Pi SDK under a wrapper installation layout', async () => {
  const install = join(temp, 'pi');
  const executable = join(install, 'bin', 'pi');
  const sdk = join(install, 'lib', 'pi', 'node_modules', '@earendil-works', 'pi-coding-agent');
  await mkdir(dirname(executable), { recursive: true });
  await mkdir(sdk, { recursive: true });
  await writeFile(executable, '#!/usr/bin/env bash\nexec "pi" "$@"\n', { mode: 0o700 });
  await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent' }));

  const project = fileURLToPath(new URL('../..', import.meta.url));
  const module = pathToFileURL(join(project, '.test-dist/src/pi-sdk.js')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { findPiSdk } from ${JSON.stringify(module)}; console.log(findPiSdk());`], {
    cwd: project,
    env: { ...process.env, PI_MANAGER_PI: executable, PI_MANAGER_SDK_PATH: '' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), sdk);
});
