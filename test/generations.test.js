import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findPiSdk } from '../src/pi-sdk.js';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-generations-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
const core = await import('../src/core.js');
const { packageOperation, rollbackPackages, packageVersions, togglePackage } = await import('../src/packages.js');
const { inventory, toggleResource, createContext } = await import('../src/resources.js');
const { PACKAGE_STATE_KEY } = await import('../src/package-state.js');
const { copyOwnedTree } = await import('../src/generations.js');
let sdk; try { sdk = findPiSdk(); } catch {}
const integration = sdk ? {} : { skip: 'Pi SDK required' };
after(() => rm(temp, { recursive: true, force: true }));

async function seed(name) {
  await core.createProfile(name);
  const root = core.profilePath(name);
  const pkg = join(root, 'npm/node_modules/fixture');
  await mkdir(join(pkg, 'prompts'), { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', pi: { prompts: ['./prompts'] } }));
  await writeFile(join(pkg, 'prompts/a.md'), 'version one');
  await writeFile(join(root, 'npm/package.json'), JSON.stringify({ dependencies: { fixture: '1.0.0' } }));
  const settings = await core.getSettings(name);
  settings.packages = ['npm:fixture'];
  await core.saveSettings(name, settings);
  return { root, pkg };
}
async function fakeWorker(name, code) {
  const path = join(temp, name);
  await writeFile(path, `#!/usr/bin/env node\nconst fs=require('node:fs'),p=require('node:path'),r=process.env.PI_CODING_AGENT_DIR;const settings=JSON.parse(fs.readFileSync(p.join(r,'settings.json'),'utf8'));${code}`, { mode: 0o700 });
  return path;
}
const changeVersion = `const f=p.join(r,'npm/node_modules/fixture');fs.writeFileSync(p.join(f,'package.json'),JSON.stringify({name:'fixture',version:'2.0.0',pi:{prompts:['./prompts']}}));fs.writeFileSync(p.join(f,'prompts/a.md'),'version two');process.send({settings},()=>process.exit(0));`;

test('candidate install validates and atomically selects copied package files; rollback is offline and preserves non-package data', integration, async () => {
  const { root, pkg } = await seed('switch');
  await writeFile(join(root, 'auth.json'), 'credential sentinel');
  await core.createProfile('unrelated');
  const worker = await fakeWorker('success-worker', changeVersion);
  const result = await packageOperation('switch', 'update', 'npm:fixture', { piCommand: worker });
  assert.ok(result.previous);
  assert.equal(await readFile(join(pkg, 'prompts/a.md'), 'utf8'), 'version one');
  const raw = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
  const binding = raw[PACKAGE_STATE_KEY].bindings['npm:fixture'];
  assert.equal(raw.packages[0], binding);
  assert.equal(await readFile(join(binding, 'prompts/a.md'), 'utf8'), 'version two');
  assert.deepEqual((await core.getSettings('switch')).packages, ['npm:fixture']);
  let current = await inventory('switch');
  assert.equal(current.packages[0].version, '2.0.0');
  assert.equal(current.resources.find(r => r.type === 'prompts').source, 'npm:fixture');
  const a = current.resources.find(r => r.type === 'prompts');
  await toggleResource('switch', a.id, false);
  await togglePackage('switch', 'npm:fixture', false);
  await createContext('switch', 'after-update', 'Keep this unrelated context');
  await rollbackPackages('switch');
  assert.equal((await core.getMetadata('switch')).contexts[0].name, 'after-update');
  current = await inventory('switch');
  assert.equal(current.packages[0].version, '1.0.0');
  assert.equal(current.packages[0].enabled, true);
  assert.equal(await readFile(join(root, 'auth.json'), 'utf8'), 'credential sentinel');
  const state = await packageVersions('switch');
  assert.equal(state.active, result.previous);
  await rollbackPackages('switch');
  current = await inventory('switch');
  assert.equal(current.packages[0].enabled, false);
  await togglePackage('switch', 'npm:fixture', true);
  assert.equal((await inventory('switch')).resources.find(r => r.type === 'prompts').enabled, false);
  await core.copyProfile('switch', 'copied-generation');
  const copyRaw = JSON.parse(await readFile(join(core.profilePath('copied-generation'), 'settings.json'), 'utf8'));
  assert.equal(copyRaw[PACKAGE_STATE_KEY], undefined);
  assert.equal(copyRaw.packages[0].source, 'npm:fixture');
});

test('worker failure discards only candidate files; current settings and package bytes remain identical', integration, async () => {
  const { root, pkg } = await seed('failure');
  const before = await readFile(join(root, 'settings.json'), 'utf8');
  const worker = await fakeWorker('failure-worker', `fs.writeFileSync(p.join(r,'npm/node_modules/fixture/prompts/a.md'),'damaged candidate');process.exit(1);`);
  await assert.rejects(packageOperation('failure', 'update', 'npm:fixture', { piCommand: worker }), /Active package generation unchanged/);
  assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), before);
  assert.equal(await readFile(join(pkg, 'prompts/a.md'), 'utf8'), 'version one');
  assert.deepEqual(await readdir(join(root, '.packages')), []);
});

test('validation failure never commits a missing managed package', integration, async () => {
  const { root, pkg } = await seed('invalid');
  const before = await readFile(join(root, 'settings.json'), 'utf8');
  const worker = await fakeWorker('invalid-worker', `fs.rmSync(p.join(r,'npm/node_modules/fixture'),{recursive:true});process.send({settings},()=>process.exit(0));`);
  await assert.rejects(packageOperation('invalid', 'update', 'npm:fixture', { piCommand: worker }), /Active package generation unchanged/);
  assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), before);
  assert.equal(await readFile(join(pkg, 'prompts/a.md'), 'utf8'), 'version one');
});

test('failure immediately before reference switch leaves active generation unchanged', integration, async () => {
  const { root } = await seed('commit-fail');
  const before = await readFile(join(root, 'settings.json'), 'utf8');
  await assert.rejects(packageOperation('commit-fail', 'update', 'npm:fixture', {
    piCommand: await fakeWorker('commit-worker', changeVersion),
    beforeCommit: () => { throw new Error('injected switch failure'); },
  }), /injected switch failure/);
  assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), before);
  assert.deepEqual(await readdir(join(root, '.packages')), []);
});

test('running manager profile locks out installation and rollback', integration, async () => {
  await seed('busy');
  await core.withProfileLock('busy', async () => {
    await assert.rejects(packageOperation('busy', 'update'), /busy/);
    await assert.rejects(rollbackPackages('busy'), /busy/);
  });
});

test('candidate copy refuses dependency symlinks that escape manager-owned packages', integration, async () => {
  const { root, pkg } = await seed('escape');
  const external = join(temp, 'external'); await mkdir(external);
  await writeFile(join(external, 'sentinel'), 'unchanged');
  await symlink(external, join(pkg, 'external'));
  await assert.rejects(packageOperation('escape', 'update'), /External package symlink/);
  assert.equal(await readFile(join(external, 'sentinel'), 'utf8'), 'unchanged');
  assert.deepEqual(await readdir(join(root, '.packages')), []);
});
