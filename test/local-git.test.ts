import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localPackageOrigin } from '../src/local-git.js';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-local-git-')));
after(() => rm(temp, { recursive: true, force: true }));
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { env: gitEnv, stdio: 'pipe' });

async function checkout(name: string, origin?: string) {
  const root = join(temp, name); await mkdir(root);
  git(root, 'init');
  if (origin) git(root, 'config', '--local', 'remote.origin.url', origin);
  return root;
}

test('read-only Git origin lookup ignores inherited overrides and included configs', async () => {
  const origin = 'https://github.com/meatRoll/pi-todos.git';
  const root = await checkout('todos', origin);
  const other = await checkout('other', 'https://github.com/upstream/wrong.git');
  const included = join(temp, 'included.config');
  await writeFile(included, '[remote "origin"]\n  url = https://github.com/upstream/included.git\n');
  git(root, 'config', '--local', 'include.path', included);
  const config = await readFile(join(root, '.git/config'), 'utf8');
  const overrides = { GIT_DIR: join(other, '.git'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url', GIT_CONFIG_VALUE_0: 'https://github.com/upstream/environment.git' };
  const before = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, overrides);
    assert.equal(await localPackageOrigin(root), origin);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  assert.equal(await readFile(join(root, '.git/config'), 'utf8'), config);
});

test('local origin lookup supports worktree gitfiles and never borrows a parent repository', async () => {
  const origin = 'git@github.com:meatRoll/worktree.git';
  const root = await checkout('worktree-main', origin);
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Fixture');
  const worktree = join(temp, 'linked-checkout');
  git(root, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', worktree);
  assert.match(await readFile(join(worktree, '.git'), 'utf8'), /^gitdir:/);
  assert.equal(await localPackageOrigin(worktree), origin);
  const nested = join(root, 'nested-package'); await mkdir(nested);
  assert.equal(await localPackageOrigin(nested), undefined);
  assert.equal(await localPackageOrigin(join(temp, 'missing')), undefined);
  assert.equal(await localPackageOrigin(await checkout('without-origin')), undefined);
  const malformed = join(temp, 'malformed'); await mkdir(malformed); await writeFile(join(malformed, '.git'), 'not a gitfile');
  assert.equal(await localPackageOrigin(malformed), undefined);
});

test('origin lookup respects cancellation before or during the lookup', async () => {
  const root = await checkout('cancel', 'https://github.com/meatRoll/cancel.git');
  const before = await readFile(join(root, '.git/config'), 'utf8');
  const controller = new AbortController();
  const pending = localPackageOrigin(root, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(localPackageOrigin(root, controller.signal), { name: 'AbortError' });
  assert.equal(await readFile(join(root, '.git/config'), 'utf8'), before);
});
