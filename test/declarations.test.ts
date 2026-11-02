import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findPiSdk } from '../src/pi-sdk.js';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-declarations-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
const core = await import('../src/core.js');
const { generationPath } = await import('../src/generations.js');
const {
  activateDeclarations, gitCommit, gitIdentity, planDeclarations, sourceIdentity, splitGitSource,
} = await import('../src/declarations.js');
let sdk: string | undefined; try { sdk = findPiSdk(); } catch {}
const integration = sdk ? {} : { skip: 'Pi SDK required' };
after(() => rm(temp, { recursive: true, force: true }));

const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();

async function createCheckout(root: string, manifest: Record<string, unknown>) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(root, 'index.js'), 'export {};\n');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init']]) {
    git(root, ...args);
  }
  return git(root, 'rev-parse', 'HEAD');
}

test('pinned sources keep their configured spelling and drop only the ref', () => {
  assert.deepEqual(splitGitSource('git:github.com/acme/two@v1.0.0'), { repository: 'git:github.com/acme/two', ref: 'v1.0.0' });
  assert.deepEqual(splitGitSource('https://github.com/acme/three.git'), { repository: 'https://github.com/acme/three.git' });
  assert.deepEqual(splitGitSource('git@github.com:acme/four@main'), { repository: 'git@github.com:acme/four', ref: 'main' });
  assert.deepEqual(splitGitSource('git:git@github.com:acme/five@deadbeef'), { repository: 'git:git@github.com:acme/five', ref: 'deadbeef' });
  // A host without a ref must not be mistaken for one.
  assert.deepEqual(splitGitSource('git:https://user@github.com/acme/six'), { repository: 'git:https://user@github.com/acme/six' });
});

test('identity is the host/repository pair Pi matches declarations by', () => {
  assert.equal(gitIdentity('git:github.com/acme/two@v1'), 'git:github.com/acme/two');
  assert.equal(gitIdentity('https://github.com/acme/three.git'), 'git:github.com/acme/three');
  assert.equal(gitIdentity('git:https://github.com/acme/four#branch'), 'git:github.com/acme/four');
  assert.equal(sourceIdentity('npm:@scope/name@1.2.3'), 'npm:@scope/name');
  assert.equal(sourceIdentity('/tmp/package'), 'local:/tmp/package');
  assert.equal(sourceIdentity('relative-package'), undefined);
});

test('planning pins Git commits, npm versions, preserves filters and keeps local references', async () => {
  await core.createProfile('plan');
  const root = core.profilePath('plan');
  const generationId = '1793585415868-3ac11a4a-90ea-40ca-99d1-af18ae477954';
  const generation = generationPath(root, generationId);
  const gitCheckout = join(generation, 'git/github.com/acme/two');
  const commit = await createCheckout(gitCheckout, { name: '@acme/two' });
  const npmCheckout = join(generation, 'npm/node_modules/one');
  await createCheckout(npmCheckout, { name: 'one', version: '1.4.2' });
  const plainGit = join(generation, 'git/github.com/acme/three');
  await mkdir(plainGit, { recursive: true });
  await writeFile(join(plainGit, 'package.json'), JSON.stringify({ name: 'three' }));
  const external = join(temp, 'local-tool');
  await mkdir(external, { recursive: true });
  await writeFile(join(external, 'package.json'), JSON.stringify({ name: 'local-tool' }));

  const settings = await core.getSettings('plan');
  settings.packages = [
    { source: 'git:github.com/acme/two@v1', extensions: ['+index.js'] },
    'npm:one',
    'git:github.com/acme/three',
    external,
  ];
  settings.piManagerPackages = {
    format: 1, active: generationId, disabledPackages: {},
    bindings: {
      'git:github.com/acme/two@v1': gitCheckout,
      'npm:one': npmCheckout,
      'git:github.com/acme/three': plainGit,
    },
  };
  await core.saveSettings('plan', settings);

  const planned = await planDeclarations('plan');
  assert.deepEqual(planned.declarations.map(item => [item.kind, item.pinned]), [
    ['git', `git:github.com/acme/two@${commit}`],
    ['npm', 'npm:one@1.4.2'],
    ['local', external],
  ]);
  assert.deepEqual(planned.declarations[0].filters,
    { source: 'git:github.com/acme/two@v1', extensions: ['+index.js'] });
  assert.equal(planned.declarations[0].snapshot, 'git/github.com/acme/two');
  assert.equal(planned.declarations[1].snapshot, 'npm/node_modules/one');
  // A checkout without usable Git history cannot be pinned; publishing falls
  // back to copied files for that package instead of dropping its resources.
  assert.deepEqual(planned.skipped, [{ source: 'git:github.com/acme/three', reason: 'checkout has no readable commit' }]);
});

test('activation replaces published declarations, keeps foreign ones and never touches local entries', integration, async () => {
  const agentDir = join(temp, 'agent');
  await mkdir(agentDir, { recursive: true });
  const checkout = join(temp, 'agent-checkout');
  const commit = await createCheckout(checkout, { name: '@acme/two' });
  const foreign = 'git:github.com/someone/own';
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    defaultModel: 'keep-me',
    packages: [
      foreign,
      { source: 'git:github.com/acme/old@0000000', extensions: [] },
      { source: 'git:github.com/acme/two@old', extensions: ['+legacy.ts'] },
      join(temp, 'local-tool'),
    ],
  }));

  const result = await activateDeclarations(
    [{ source: `git:github.com/acme/two@${commit}`, extensions: ['+index.js'] }, 'npm:one@1.4.2'],
    ['git:github.com/acme/old', 'git:github.com/acme/two'],
    { agentDir, cwd: agentDir, install: false },
  );
  assert.deepEqual(result.applied, [`git:github.com/acme/two@${commit}`, 'npm:one@1.4.2']);
  assert.deepEqual(result.removed, ['git:github.com/acme/old@0000000', 'git:github.com/acme/two@old']);

  const saved = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  assert.equal(saved.defaultModel, 'keep-me');
  assert.deepEqual(saved.packages, [
    foreign,
    { source: `git:github.com/acme/two@${commit}`, extensions: ['+index.js'] },
    join(temp, 'local-tool'),
    'npm:one@1.4.2',
  ]);
  assert.equal(await gitCommit(checkout), commit);

  // Re-applying the same declarations is a no-op, so a redundant publish does
  // not churn the user's Pi settings.
  const again = await activateDeclarations(saved.packages, ['git:github.com/acme/two', 'npm:one'], {
    agentDir, cwd: agentDir, install: false,
  });
  assert.equal(again.unchanged, true);
});
