import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findPiSdk } from '../src/pi-sdk.js';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-bundle-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
const core = await import('../src/core.js');
const { createContext, writeResource, inventory } = await import('../src/resources.js');
const { publishBundle, publishedBundle, BUNDLE_DIR } = await import('../src/bundle.js');
let sdk: string | undefined; try { sdk = findPiSdk(); } catch {}
const integration = sdk ? {} : { skip: 'Pi SDK required' };
after(() => rm(temp, { recursive: true, force: true }));

test('manager-only bundle has one extension entry, no factory side effects or runtime credentials', async () => {
  const result = await publishBundle(null);
  const manifest = JSON.parse(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'));
  assert.equal(manifest.pi.extensions.length, 1);
  assert.deepEqual(manifest.pi.skills, []);
  assert.deepEqual(manifest.piManager, result);
  assert.equal((await publishedBundle())?.profile, null);
  const wrapper = await readFile(manifest.pi.extensions[0], 'utf8');
  assert.match(wrapper, /export default function/);
  assert.match(wrapper, /extension\.js/);
  assert.ok(!wrapper.includes('auth.json'));
});

test('published resources and context are detached from staging edits and deletion', integration, async () => {
  await core.createProfile('preset');
  const root = core.profilePath('preset');
  await mkdir(join(root, 'resources/prompts'), { recursive: true });
  await writeFile(join(root, 'resources/prompts/demo.md'), 'original prompt');
  await writeFile(join(root, 'auth.json'), 'never export credentials');
  const settings = await core.getSettings('preset'); settings.prompts = ['resources/prompts/demo.md'];
  await core.saveSettings('preset', settings);
  await createContext('preset', 'rules', 'original context');
  const first = await publishBundle('preset');
  const old = JSON.parse(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'));
  const prompt = (await inventory('preset')).resources.find(item => item.type === 'prompts'); assert.ok(prompt);
  await writeResource('preset', prompt.id, 'edited staging prompt');
  const context = (await inventory('preset')).resources.find(item => item.type === 'context'); assert.ok(context);
  await writeResource('preset', context.id, 'edited staging context');
  assert.equal(await readFile(old.pi.prompts[0], 'utf8'), 'original prompt');
  assert.equal(first.contexts[0].content, 'original context');
  const second = await publishBundle('preset'); assert.notEqual(first.id, second.id);
  await core.deleteProfile('preset');
  assert.equal(await readFile(old.pi.prompts[0], 'utf8'), 'original prompt');
  assert.equal(second.contexts[0].content, 'edited staging context');
  const exportedRoot = join(BUNDLE_DIR, '.snapshots', second.id);
  await assert.rejects(readFile(join(exportedRoot, 'auth.json')), /ENOENT/);
  const current = JSON.parse(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'));
  assert.equal(await readFile(current.pi.prompts[0], 'utf8'), 'edited staging prompt');
  assert.equal((await publishedBundle())?.profile, 'preset');
});

test('publish copies owned package bytes, preserves external references and rejects unsafe symlinks without commit', integration, async () => {
  await core.createProfile('packages'); const root = core.profilePath('packages');
  const owned = join(root, 'npm/node_modules/demo'); await mkdir(join(owned, 'prompts'), { recursive: true });
  await writeFile(join(owned, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', pi: { prompts: ['./prompts'] } }));
  await writeFile(join(owned, 'prompts/a.md'), 'owned prompt');
  const external = join(temp, 'external'); await mkdir(join(external, 'prompts'), { recursive: true });
  await writeFile(join(external, 'package.json'), JSON.stringify({ name: 'external', version: '1.0.0', pi: { prompts: ['./prompts'] } }));
  await writeFile(join(external, 'prompts/b.md'), 'external prompt');
  const settings = await core.getSettings('packages'); settings.packages = ['npm:demo', external]; await core.saveSettings('packages', settings);
  await publishBundle('packages');
  const before = await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'); const manifest = JSON.parse(before);
  assert.ok(manifest.pi.prompts.some((path: string) => path.startsWith(join(BUNDLE_DIR, '.snapshots'))));
  assert.ok(manifest.pi.prompts.includes(join(external, 'prompts/b.md')));
  await writeFile(join(owned, 'prompts/a.md'), 'new staging bytes');
  const copied = manifest.pi.prompts.find((path: string) => path.endsWith('/prompts/a.md'));
  assert.equal(await readFile(copied, 'utf8'), 'owned prompt');
  await symlink(external, join(owned, 'escape'));
  await assert.rejects(publishBundle('packages'), /External package symlink/);
  assert.equal(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'), before);
  assert.equal(await readFile(join(external, 'prompts/b.md'), 'utf8'), 'external prompt');
});

test('missing package declarations cannot replace an existing published bundle', integration, async () => {
  await core.createProfile('missing');
  const settings = await core.getSettings('missing'); settings.packages = ['npm:missing-test-package']; await core.saveSettings('missing', settings);
  const before = await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8');
  await assert.rejects(publishBundle('missing'), /Missing package|Package worker exited/);
  assert.equal(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'), before);
});

test('busy staging profile cannot publish', async () => {
  await core.createProfile('locked');
  await core.withProfileLock('locked', async () => { await assert.rejects(publishBundle('locked'), /busy/); });
});

test('publication exports preset and package resources but never user-level discoveries', async () => {
  const { exportableResources } = await import('../src/bundle.js');
  const resource = (type: string, origin: string, enabled = true) => ({ type, origin, enabled, path: `/x/${type}-${origin}` });
  const kept = exportableResources([
    resource('extensions', 'package'),
    resource('skills', 'standalone'),
    resource('skills', 'global'),
    resource('extensions', 'global'),
    resource('prompts', 'standalone', false),
    resource('context', 'standalone'),
  ] as never);
  assert.deepEqual(kept.map(item => `${item.type}:${item.origin}`), ['extensions:package', 'skills:standalone']);
});
