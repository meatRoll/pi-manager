import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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

test('manager-only bundle carries resources and the binding, never a manager entry or credentials', async () => {
  const result = await publishBundle(null);
  const manifest = JSON.parse(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'));
  // The manager is its own Pi package; a generated entry would register
  // /manager twice and pin the snapshot to one implementation path.
  assert.deepEqual(manifest.pi.extensions, []);
  assert.deepEqual(manifest.pi.skills, []);
  assert.deepEqual(manifest.piManager, result);
  assert.equal((await publishedBundle())?.profile, null);
  assert.equal(await readdir(join(BUNDLE_DIR, '.snapshots', result.id)).then(names => names.includes('extension.mjs')), false);
  const manifestText = await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8');
  assert.ok(!manifestText.includes('auth.json'));
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

test('pinned package resources are declared instead of copied, external references stay live', integration, async () => {
  await core.createProfile('packages'); const root = core.profilePath('packages');
  const generationId = '1793585415868-3ac11a4a-90ea-40ca-99d1-af18ae477954';
  const generation = join(root, '.packages', generationId);
  const owned = join(generation, 'git/github.com/acme/demo'); await mkdir(join(owned, 'prompts'), { recursive: true });
  await writeFile(join(owned, 'package.json'), JSON.stringify({ name: 'demo', pi: { prompts: ['./prompts'] } }));
  await writeFile(join(owned, 'prompts/a.md'), 'owned prompt');
  execFileSync('git', ['-C', owned, 'init'], { stdio: 'pipe' });
  execFileSync('git', ['-C', owned, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', owned, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'demo'], { stdio: 'pipe' });
  const commit = execFileSync('git', ['-C', owned, 'rev-parse', 'HEAD'], { stdio: 'pipe', encoding: 'utf8' }).trim();
  const external = join(temp, 'external'); await mkdir(join(external, 'prompts'), { recursive: true });
  await writeFile(join(external, 'package.json'), JSON.stringify({ name: 'external', version: '1.0.0', pi: { prompts: ['./prompts'] } }));
  await writeFile(join(external, 'prompts/b.md'), 'external prompt');
  const settings = await core.getSettings('packages');
  settings.packages = [{ source: 'git:github.com/acme/demo', prompts: ['+prompts/a.md'] }, external];
  settings.piManagerPackages = { format: 1, active: generationId, bindings: { 'git:github.com/acme/demo': owned }, disabledPackages: {} };
  await core.saveSettings('packages', settings);
  const published = await publishBundle('packages');
  const before = await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'); const manifest = JSON.parse(before);
  // Neither package decays into a copied file: the Git package is declared at
  // its commit and the external local package stays a live reference, exactly
  // as Pi handles local sources. The bundle carries only preset-owned files.
  assert.deepEqual(manifest.pi.prompts, []);
  assert.deepEqual(published.declarations, [
    { kind: 'git', source: 'git:github.com/acme/demo', identity: 'git:github.com/acme/demo',
      pinned: `git:github.com/acme/demo@${commit}`, ref: commit, snapshot: 'git/github.com/acme/demo',
      filters: { source: 'git:github.com/acme/demo', prompts: ['+prompts/a.md'] } },
    { kind: 'local', source: external, identity: `local:${external}`, pinned: external, filters: external },
  ]);
  // The bytes still travel in the snapshot, so a pinned declaration can be
  // reconciled offline and old publications stay readable.
  const copied = join(BUNDLE_DIR, '.snapshots', published.id, 'git/github.com/acme/demo/prompts/a.md');
  assert.equal(await readFile(copied, 'utf8'), 'owned prompt');
  assert.equal(await readFile(join(external, 'prompts/b.md'), 'utf8'), 'external prompt');
  await writeFile(join(owned, 'prompts/a.md'), 'new staging bytes');
  assert.equal(await readFile(copied, 'utf8'), 'owned prompt');
  await symlink(external, join(owned, 'escape'));
  await assert.rejects(publishBundle('packages'), /External package symlink/);
  assert.equal(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'), before);
  assert.equal(await readFile(join(external, 'prompts/b.md'), 'utf8'), 'external prompt');
});;

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

test('a publication that cannot declare its packages never replaces the active one', integration, async () => {
  await core.createProfile('atomic'); const root = core.profilePath('atomic');
  const generationId = '1793585415868-3ac11a4a-90ea-40ca-99d1-af18ae477954';
  const checkout = join(root, '.packages', generationId, 'git/github.com/acme/demo');
  await mkdir(checkout, { recursive: true });
  await writeFile(join(checkout, 'index.js'), 'export {};\n');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'demo']]) {
    execFileSync('git', ['-C', checkout, ...args], { stdio: 'pipe' });
  }
  const settings = await core.getSettings('atomic');
  settings.packages = ['git:github.com/acme/demo'];
  settings.piManagerPackages = {
    format: 1, active: generationId, disabledPackages: {},
    bindings: { 'git:github.com/acme/demo': checkout },
  };
  await core.saveSettings('atomic', settings);
  const before = await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8');
  const snapshotsBefore = (await readdir(join(BUNDLE_DIR, '.snapshots'))).length;
  const failing = { SettingsManager: { create: () => { throw new Error('settings unavailable'); } } } as never;
  await assert.rejects(
    publishBundle('atomic', { activate: true, install: false, agentDir: temp, sdk: failing }),
    /settings unavailable/,
  );
  assert.equal(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'), before);
  assert.equal((await readdir(join(BUNDLE_DIR, '.snapshots'))).length, snapshotsBefore);
});

test('activating while publishing writes pinned declarations and the manifest', integration, async () => {
  const agentDir = join(temp, 'atomic-agent'); await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['git:github.com/someone/own'] }));
  const published = await publishBundle('atomic', { activate: true, install: false, agentDir, cwd: agentDir });
  const saved = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  assert.equal(saved.packages.length, 2);
  assert.equal(saved.packages[0], 'git:github.com/someone/own');
  assert.match(saved.packages[1], /^git:github\.com\/acme\/demo@[0-9a-f]{40}$/);
  assert.equal(published.declarations?.[0].pinned, saved.packages[1]);
});
