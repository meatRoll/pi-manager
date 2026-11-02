import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-format-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
delete process.env.PI_MANAGER_PUBLISH_DIR;
const { BUNDLE_DIR, publishBundle, publishedBundle, publishedBundleSync } = await import('../src/bundle.js');
const { MANAGER_HOME } = await import('../src/storage.js');
after(() => rm(temp, { recursive: true, force: true }));

const snapshotId = '1793610453990-cfa8599a-4483-4f13-a49b-3c77aecdfb1c';

async function writeManifest(piManager: Record<string, unknown>) {
  await mkdir(join(BUNDLE_DIR, '.snapshots', String(piManager.id || 'x')), { recursive: true });
  await writeFile(join(BUNDLE_DIR, 'package.json'), JSON.stringify({
    name: 'pi-manager-local-bundle', version: '1.5.0', private: true, type: 'module',
    pi: { extensions: [], skills: [], prompts: [], themes: [] },
    piManager,
  }));
}

test('a publication written by a newer build is readable, and cannot be overwritten', async () => {
  await writeManifest({
    format: 2, id: snapshotId, profile: 'mine', managerHome: MANAGER_HOME, contexts: [],
    declarations: [{ kind: 'git', source: 'git:github.com/owner/demo' }], superseded: [],
  });
  const loaded = await publishedBundle();
  assert.equal(loaded?.format, 2);
  assert.equal(loaded?.id, snapshotId);
  assert.equal(loaded?.profile, 'mine');
  assert.equal(publishedBundleSync()?.id, snapshotId);
  // Rewriting it with this build would drop whatever format 2 carries.
  await assert.rejects(publishBundle(null), /format 2, which this build cannot rewrite/);
  const after = JSON.parse(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'));
  assert.equal(after.piManager.format, 2);
  assert.equal(after.piManager.declarations.length, 1);
});

test('foreign manager homes, unknown formats and unusable ids stay rejected', async () => {
  await writeManifest({ format: 2, id: snapshotId, profile: 'mine', managerHome: '/somewhere/else', contexts: [] });
  await assert.rejects(publishedBundle(), /Invalid pi-manager export/);
  assert.equal(publishedBundleSync(), null);

  await writeManifest({ format: 9, id: snapshotId, profile: 'mine', managerHome: MANAGER_HOME, contexts: [] });
  await assert.rejects(publishedBundle(), /Invalid pi-manager export/);
  assert.equal(publishedBundleSync(), null);

  await writeManifest({ format: 2, id: '', profile: 'mine', managerHome: MANAGER_HOME, contexts: [] });
  await assert.rejects(publishedBundle(), /Invalid pi-manager export/);
  assert.equal(publishedBundleSync(), null);
});
