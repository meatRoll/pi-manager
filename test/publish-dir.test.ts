import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

// Each scenario needs its own module instance because the publish directory is
// resolved at import time, so probe it in a subprocess with a clean environment.
const storageModule = new URL('../src/storage.js', import.meta.url).href;
const bundleModule = new URL('../src/bundle.js', import.meta.url).href;
function probe(script: string, environment: Record<string, string>) {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('PI_MANAGER_') && value !== undefined) base[key] = value;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...base, ...environment }, encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop()!);
}

test('the publish directory comes from state when no environment variable is set', async () => {
  const home = join(temp, 'state-home');
  const saved = join(temp, 'saved-disk', 'packages');
  const read = async () => probe(
    `const s = await import(${JSON.stringify(storageModule)}); console.log(JSON.stringify({ dir: s.PUBLISH_DIR, source: s.PUBLISH_DIR_SOURCE }))`,
    { PI_MANAGER_HOME: home },
  );
  assert.deepEqual(await read(), { dir: join(home, 'pi-package'), source: 'default' });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'state.json'), JSON.stringify({ defaultProfile: null, publishDir: saved }));
  assert.deepEqual(await read(), { dir: saved, source: 'state' });
  assert.deepEqual(await probe(
    `const s = await import(${JSON.stringify(storageModule)}); console.log(JSON.stringify({ dir: s.PUBLISH_DIR, source: s.PUBLISH_DIR_SOURCE }))`,
    { PI_MANAGER_HOME: home, PI_MANAGER_PUBLISH_DIR: join(temp, 'env-disk') },
  ), { dir: join(temp, 'env-disk'), source: 'env' });
});

test('a malformed state file falls back to the default instead of breaking the manager', async () => {
  const home = join(temp, 'broken-home');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'state.json'), '{ not json');
  assert.deepEqual(await probe(
    `const s = await import(${JSON.stringify(storageModule)}); console.log(JSON.stringify({ dir: s.PUBLISH_DIR, source: s.PUBLISH_DIR_SOURCE }))`,
    { PI_MANAGER_HOME: home },
  ), { dir: join(home, 'pi-package'), source: 'default' });
});

test('saved publish directories are validated like the environment variable', async () => {
  const home = join(temp, 'validate-home');
  const attempt = (target: string) => probe(
    `const s = await import(${JSON.stringify(storageModule)});
     try { await s.setPublishDir(${JSON.stringify(target)}); console.log(JSON.stringify({ ok: true })); }
     catch (error) { console.log(JSON.stringify({ ok: false, message: error.message })); }`,
    { PI_MANAGER_HOME: home },
  );
  const insideProfiles = await attempt(join(home, 'profiles', 'mine'));
  assert.equal(insideProfiles.ok, false);
  assert.match(insideProfiles.message, /outside the profiles/);
  const insidePi = await attempt(join(process.env.HOME || '', '.pi', 'packages'));
  assert.equal(insidePi.ok, false);
  assert.match(insidePi.message, /must not overlap ~\/\.pi/);
  const accepted = await attempt(join(temp, 'accepted-disk'));
  assert.equal(accepted.ok, true);
  const state = JSON.parse(await readFile(join(home, 'state.json'), 'utf8'));
  assert.equal(state.publishDir, join(temp, 'accepted-disk'));
  assert.equal(state.defaultProfile, null);
});

test('publishing refuses a configured directory under an unwritable mount point', async () => {
  const { chmod, mkdir } = await import('node:fs/promises');
  const home = join(temp, 'offline-home');
  const mount = join(temp, 'detached-volume');
  await mkdir(mount, { recursive: true });
  await chmod(mount, 0o500);
  try {
    const result = await probe(
      `const b = await import(${JSON.stringify(bundleModule)});
       try { await b.publishBundle(null); console.log(JSON.stringify({ ok: true })); }
       catch (error) { console.log(JSON.stringify({ ok: false, message: error.message })); }`,
      { PI_MANAGER_HOME: home, PI_MANAGER_PUBLISH_DIR: join(mount, 'packages') },
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /Publish directory unavailable/);
  } finally { await chmod(mount, 0o700); }
  assert.equal(existsSync(join(home, 'pi-package')), false);
});
