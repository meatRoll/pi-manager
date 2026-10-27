import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-publish-dir-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
process.env.PI_MANAGER_PUBLISH_DIR = join(temp, 'big-disk', 'pi-package');
const { BUNDLE_DIR, publishBundle, publishedBundle } = await import('../src/bundle.js');
const { MANAGER_HOME, PUBLISH_DIR, PUBLISH_DIR: publishDir, safePath } = await import('../src/storage.js');
after(() => rm(temp, { recursive: true, force: true }));

test('publication honours PI_MANAGER_PUBLISH_DIR outside the manager home', async () => {
  assert.equal(PUBLISH_DIR, join(temp, 'big-disk', 'pi-package'));
  assert.equal(BUNDLE_DIR, PUBLISH_DIR);
  assert.equal(MANAGER_HOME, join(temp, 'manager'));
  const published = await publishBundle(null);
  assert.ok(existsSync(join(PUBLISH_DIR, 'package.json')));
  assert.ok(existsSync(join(PUBLISH_DIR, '.snapshots', published.id)));
  assert.equal((await publishedBundle())?.id, published.id);
  assert.equal(existsSync(join(MANAGER_HOME, 'pi-package')), false);
});

test('the redirected directory is writable while everything else stays refused', async () => {
  await assert.rejects(safePath(join(temp, 'somewhere-else', 'x')), /outside manager home/);
  await assert.rejects(safePath(join(temp, 'big-disk', '..', 'sibling', 'x')), /outside manager home/);
  assert.equal(await safePath(join(publishDir, 'package.json')), join(publishDir, 'package.json'));
  assert.equal(await safePath(join(MANAGER_HOME, 'state.json')), join(MANAGER_HOME, 'state.json'));
});
