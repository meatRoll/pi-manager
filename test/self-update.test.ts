import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-self-update-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
const { selfUpdate, managerRoot } = await import('../src/self-update.js');
after(() => rm(temp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();

let fixtures = 0;
async function clonePair() {
  const base = join(temp, `fixture-${++fixtures}`);
  const remote = join(base, 'remote', 'pi-manager');
  const seed = join(base, 'seed');
  await mkdir(remote, { recursive: true });
  git(temp, 'init', '--bare', '-q', remote);
  await mkdir(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(join(seed, 'README.md'), 'first\n');
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-q', '-m', 'first');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  const work = join(base, 'work', 'pi-manager');
  git(temp, 'clone', '-q', remote, work);
  git(work, 'config', 'user.name', 'test');
  git(work, 'config', 'user.email', 'test@example.test');
  return { remote, seed, work };
}

test('a clean checkout fast-forwards to the remote without merging or republishing by default', async () => {
  const { seed, work } = await clonePair();
  await writeFile(join(seed, 'README.md'), 'second\n');
  git(seed, 'commit', '-q', '-am', 'second');
  git(seed, 'push', '-q');
  const before = git(work, 'rev-parse', '--short', 'HEAD');
  const result = await selfUpdate({ root: work, republish: false });
  assert.equal(result.before, before);
  assert.notEqual(result.after, before);
  assert.equal(result.changed, true);
  assert.equal(git(work, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'));
  assert.equal(result.republished, null);
});

test('an up-to-date checkout reports no change', async () => {
  const { work } = await clonePair();
  const result = await selfUpdate({ root: work, republish: false });
  assert.equal(result.changed, false);
  assert.equal(result.before, result.after);
});

test('uncommitted edits, unrelated remotes and non-repositories are refused', async () => {
  const { seed, work } = await clonePair();
  await writeFile(join(work, 'README.md'), 'local edit\n');
  await assert.rejects(selfUpdate({ root: work, republish: false }), /local changes/);
  git(work, 'checkout', '--', 'README.md');

  git(work, 'remote', 'set-url', 'origin', join(temp, 'seed'));
  await assert.rejects(selfUpdate({ root: work, republish: false }), /expected the pi-manager repository/);

  const plain = join(temp, 'plain');
  await mkdir(plain, { recursive: true });
  await assert.rejects(selfUpdate({ root: plain, republish: false }), /Not a Git checkout/);

  // A failing update must never leave the checkout moved or merged.
  git(work, 'remote', 'set-url', 'origin', seed);
  await writeFile(join(seed, 'README.md'), 'diverged\n');
  git(seed, 'commit', '-q', '-am', 'diverged');
  git(seed, 'push', '-q');
  await writeFile(join(seed, 'README.md'), 'ahead\n');
  git(seed, 'commit', '-q', '-am', 'ahead');
  await writeFile(join(work, 'README.md'), 'local\n');
  git(work, 'commit', '-q', '-am', 'local');
  await assert.rejects(selfUpdate({ root: work, republish: false }), /local changes|Not possible to fast-forward|diverged|refusing/i);
});

test('the manager root is the checkout that holds dist/', () => {
  assert.equal(managerRoot('file:///opt/pi-manager/dist/self-update.js'), '/opt/pi-manager');
  assert.equal(managerRoot(`file://${join(temp, 'a', 'b', 'dist', 'self-update.js')}`), join(temp, 'a', 'b'));
});
