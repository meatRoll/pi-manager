import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'pi-manager-test-'));
process.env.PI_MANAGER_HOME = join(root, 'manager');
const core = await import('../src/core.js');
const { setPackageEnabled, togglePackage, packageArgs, packageOperation } = await import('../src/packages.js');
after(() => rm(root, { recursive: true, force: true }));

test('create/list/default/delete profiles only in manager home', async () => {
  const path = await core.createProfile('review');
  assert.equal(path, core.profilePath('review'));
  assert.equal((await core.getState()).defaultProfile, 'review');
  assert.equal((await core.listProfiles()).length, 1);
  await assert.rejects(core.createProfile('review'), /EEXIST/);
  await assert.rejects(core.getSettings('missing'), /ENOENT/);
});

test('invalid names and symlink profiles cannot redirect writes', async () => {
  for (const name of ['../escape', '', '.', '..', 'a/b', 'a\\b']) assert.throws(() => core.profilePath(name));
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, core.profilePath('evil'));
  await assert.rejects(core.saveSettings('evil', {}), /Symlink/);
  assert.equal((await core.listProfiles()).some(p => p.name === 'evil'), false);
});

test('whole-package toggle suppresses every resource and restores exact filters', async () => {
  const entry = { source: 'npm:demo', extensions: ['!legacy/**'], skills: ['skills/a'], autoload: false };
  const settings = { packages: [structuredClone(entry)] };
  const meta = {};
  setPackageEnabled(settings, meta, 'npm:demo', false);
  assert.deepEqual(settings.packages[0], { source: 'npm:demo', extensions: [], skills: [], prompts: [], themes: [] });
  setPackageEnabled(settings, meta, 'npm:demo', false);
  setPackageEnabled(settings, meta, 'npm:demo', true);
  assert.deepEqual(settings.packages[0], entry);
  assert.deepEqual(meta.disabledPackages, {});
});

test('saved toggle uses managed metadata, not autoload=false', async () => {
  await core.createProfile('toggle');
  await core.saveSettings('toggle', { packages: ['npm:demo'] });
  await togglePackage('toggle', 'npm:demo', false);
  const entries = core.packageEntries(await core.getSettings('toggle'), core.profilePath('toggle'), await core.getMetadata('toggle'));
  assert.equal(entries[0].enabled, false);
  await togglePackage('toggle', 'npm:demo', true);
  assert.deepEqual((await core.getSettings('toggle')).packages, ['npm:demo']);
});

test('update only targets packages; source required for add/remove', () => {
  assert.deepEqual(packageArgs('update'), ['update', '--extensions', '--no-approve']);
  for (const source of ['pi', 'self', '--all', '--self']) assert.throws(() => packageArgs('update', source));
  assert.throws(() => packageArgs('add'));
  assert.throws(() => packageArgs('remove'));
});

test('busy profile refuses mutations, lock released after failure', async () => {
  await core.createProfile('locked');
  await core.withProfileLock('locked', async () => {
    await assert.rejects(core.deleteProfile('locked'), /busy/);
    await assert.rejects(togglePackage('locked', 'npm:demo', false), /busy/);
  });
  await assert.rejects(core.withProfileLock('locked', () => { throw new Error('test'); }), /test/);
  await core.deleteProfile('locked');
});

test('failed candidate subprocess leaves active settings unchanged and records diagnostics', async () => {
  await core.createProfile('rollback');
  const before = await core.getSettings('rollback');
  const fake = join(root, 'fake-pi');
  await writeFile(fake, '#!/usr/bin/env node\nconst fs=require("node:fs");fs.writeFileSync(process.env.PI_CODING_AGENT_DIR+"/settings.json", "{}");console.error("failed fixture");process.exit(1);', { mode: 0o700 });
  await assert.rejects(packageOperation('rollback', 'add', 'npm:demo', { piCommand: fake }), /Active package generation unchanged/);
  assert.deepEqual(await core.getSettings('rollback'), before);
});
