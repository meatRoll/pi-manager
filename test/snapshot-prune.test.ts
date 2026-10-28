import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-snapshot-prune-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
delete process.env.PI_MANAGER_PUBLISH_DIR;
const { BUNDLE_DIR, publishBundle, prunePublishedSnapshots } = await import('../src/bundle.js');
after(() => rm(temp, { recursive: true, force: true }));

async function snapshotIds() {
  return (await readdir(join(BUNDLE_DIR, '.snapshots'))).sort();
}

test('snapshot pruning previews and keeps the active plus newest retained snapshots', async () => {
  const published = [];
  for (let index = 0; index < 4; index += 1) published.push(await publishBundle(null));
  const preview = await prunePublishedSnapshots(2);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.active, published.at(-1)?.id);
  assert.equal(preview.retained.length, 2);
  assert.equal(preview.toRemove.length, 2);
  assert.deepEqual(await snapshotIds(), published.map(item => item.id).sort());

  const applied = await prunePublishedSnapshots(2, true);
  assert.equal(applied.dryRun, false);
  assert.deepEqual(applied.removed, preview.toRemove);
  assert.deepEqual(await snapshotIds(), applied.retained.sort());
  assert.ok(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'));
});

test('snapshot pruning refuses to remove anything when the active snapshot is missing', async () => {
  const published = await publishBundle(null);
  await rm(join(BUNDLE_DIR, '.snapshots', published.id), { recursive: true });
  await assert.rejects(prunePublishedSnapshots(1, true), /Active published snapshot is missing/);
  assert.equal((await snapshotIds()).length, 2);
  await assert.rejects(prunePublishedSnapshots(0), /positive integer/);
});
