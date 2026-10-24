import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink, readlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findPiSdk } from '../src/pi-sdk.js';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-generation-extra-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
const core = await import('../src/core.js');
const { packageOperation, rollbackPackages, packageVersions } = await import('../src/packages.js');
const { copyOwnedTree } = await import('../src/generations.js');
const { PACKAGE_STATE_KEY } = await import('../src/package-state.js');
let sdk; try { sdk = findPiSdk(); } catch {}
const integration = sdk ? {} : { skip: 'Pi SDK required' };
after(() => rm(temp, { recursive: true, force: true }));

async function fixture(name: string, version = '1.0.0') {
  const source = join(temp, name);
  await mkdir(join(source, 'prompts'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'demo', version, pi: { prompts: ['./prompts'] } }));
  await writeFile(join(source, 'prompts/demo.md'), `content ${version}`);
  return source;
}

test('internal dependency symlinks are relocated and files are not hardlinked', async () => {
  await core.createProfile('copy-tree');
  const source = join(core.profilePath('copy-tree'), 'npm');
  const target = join(core.profilePath('copy-tree'), 'copy');
  await mkdir(join(source, 'lib'), { recursive: true });
  await writeFile(join(source, 'lib/a'), 'old');
  await symlink(join(source, 'lib/a'), join(source, 'alias'));
  await copyOwnedTree(source, target);
  assert.equal(await readlink(join(target, 'alias')), 'lib/a');
  assert.notEqual((await lstat(join(source, 'lib/a'))).ino, (await lstat(join(target, 'lib/a'))).ino);
  await writeFile(join(target, 'lib/a'), 'new');
  assert.equal(await readFile(join(source, 'alias'), 'utf8'), 'old');
});

test('local package removal can restore only its reference, without mutating external contents', integration, async () => {
  await core.createProfile('local');
  const source = await fixture('external-local');
  await packageOperation('local', 'add', source);
  await packageOperation('local', 'remove', source);
  assert.deepEqual((await core.getSettings('local')).packages, []);
  await rollbackPackages('local');
  assert.deepEqual((await core.getSettings('local')).packages, [source]);
  assert.equal(await readFile(join(source, 'prompts/demo.md'), 'utf8'), 'content 1.0.0');
});

test('rollback rejects altered owned package bytes without changing settings', integration, async () => {
  await core.createProfile('tamper');
  const root = core.profilePath('tamper');
  const owned = join(root, 'npm/node_modules/demo');
  const source = await fixture('tamper-fixture');
  const { cp } = await import('node:fs/promises');
  await cp(source, owned, { recursive: true });
  const settings = await core.getSettings('tamper'); settings.packages = ['npm:demo']; await core.saveSettings('tamper', settings);
  const worker = join(temp, 'noop');
  await writeFile(worker, '#!/usr/bin/env node\nconst fs=require("node:fs"),p=require("node:path"),r=process.env.PI_CODING_AGENT_DIR;process.send({settings:JSON.parse(fs.readFileSync(p.join(r,"settings.json")))},()=>process.exit(0));', { mode: 0o700 });
  const updated = await packageOperation('tamper', 'update', 'npm:demo', { piCommand: worker });
  const state = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))[PACKAGE_STATE_KEY];
  const previous = state.previous.bindings['npm:demo'];
  await writeFile(join(previous, 'prompts/demo.md'), 'tampered');
  const before = await readFile(join(root, 'settings.json'), 'utf8');
  await assert.rejects(rollbackPackages('tamper'), /content changed/);
  assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), before);
  assert.equal((await packageVersions('tamper')).active, updated.generation);
});

test('copied declarations with no installed baseline can be initialized but do not claim rollback availability', integration, async () => {
  await core.createProfile('missing-baseline');
  const settings = await core.getSettings('missing-baseline'); settings.packages = ['npm:missing-fixture']; await core.saveSettings('missing-baseline', settings);
  const worker = join(temp, 'initialize');
  await writeFile(worker, '#!/usr/bin/env node\nconst fs=require("node:fs"),p=require("node:path"),r=process.env.PI_CODING_AGENT_DIR;const d=p.join(r,"npm/node_modules/missing-fixture");fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,"package.json"),JSON.stringify({name:"missing-fixture",version:"1.0.0",pi:{}}));process.send({settings:JSON.parse(fs.readFileSync(p.join(r,"settings.json")))},()=>process.exit(0));', { mode: 0o700 });
  const result = await packageOperation('missing-baseline', 'add', 'npm:missing-fixture', { piCommand: worker });
  assert.equal(result.previous, null);
  assert.deepEqual(result.missingBaseline, ['npm:missing-fixture']);
  await assert.rejects(rollbackPackages('missing-baseline'), /No previous/);
});
