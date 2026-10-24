import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-resources-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
const core = await import('../src/core.js');
const resources = await import('../src/resources.js');
const { togglePackage } = await import('../src/packages.js');
const { findPiSdk } = await import('../src/pi-sdk.js');
let sdk;
try { sdk = findPiSdk(); } catch { /* integration tests report skip when Pi is absent */ }
const integration = sdk ? {} : { skip: 'Installed Pi SDK required (or set PI_MANAGER_SDK_PATH)' };
after(() => rm(temp, { recursive: true, force: true }));

async function setup(name) {
  await core.createProfile(name);
  const source = join(temp, `source-${name}`);
  await mkdir(join(source, 'skills', 'demo'), { recursive: true });
  await mkdir(join(source, 'extensions'), { recursive: true });
  await mkdir(join(source, 'prompts'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', pi: {
    extensions: ['./extensions/*.js'], skills: ['./skills'], prompts: ['./prompts/*.md'],
  } }));
  await writeFile(join(source, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Test fixture\n---\n# Demo');
  await writeFile(join(source, 'extensions', 'demo.js'), 'throw new Error("MUST NOT EXECUTE DURING DISCOVERY");');
  await writeFile(join(source, 'prompts', 'a.md'), 'Prompt A');
  await writeFile(join(source, 'prompts', 'b.md'), 'Prompt B');
  const settings = await core.getSettings(name);
  settings.packages = [source];
  await core.saveSettings(name, settings);
  return source;
}

test('SDK inventory finds manifest resources without executing extension code', integration, async () => {
  const source = await setup('inventory');
  const current = await resources.inventory('inventory');
  assert.equal(current.packages[0].version, '1.0.0');
  assert.equal(current.resources.filter(r => r.origin === 'package').length, 4);
  const skill = current.resources.find(r => r.type === 'skills');
  assert.equal(skill.packageRoot, source);
  assert.equal(skill.owned, false);
  assert.equal((await resources.previewResource('inventory', skill.id)).text.includes('# Demo'), true);
  await assert.rejects(resources.removeResource('inventory', skill.id), /Cannot delete/);
});

test('per-resource toggles preserve sibling state and respect whole-package disable', integration, async () => {
  const source = await setup('toggles');
  let state = await resources.inventory('toggles');
  const a = state.resources.find(r => r.name === 'a.md');
  const b = state.resources.find(r => r.name === 'b.md');
  await resources.toggleResource('toggles', a.id, false);
  state = await resources.inventory('toggles');
  assert.equal(state.resources.find(r => r.id === a.id).enabled, false);
  assert.equal(state.resources.find(r => r.id === b.id).enabled, true);
  await togglePackage('toggles', source, false);
  state = await resources.inventory('toggles');
  assert.equal(state.resources.some(r => r.origin === 'package' && r.enabled), false);
  await togglePackage('toggles', source, true);
  state = await resources.inventory('toggles');
  assert.equal(state.resources.find(r => r.id === a.id).enabled, false);
  assert.equal(state.resources.find(r => r.id === b.id).enabled, true);
  const settings = await core.getSettings('toggles');
  settings.packages[0].prompts = [];
  await core.saveSettings('toggles', settings);
  await resources.toggleResource('toggles', a.id, true);
  state = await resources.inventory('toggles');
  assert.equal(state.resources.find(r => r.id === a.id).enabled, true);
  assert.equal(state.resources.find(r => r.id === b.id).enabled, false);
});

test('copy imports skills and context; edit/delete never touch source files', integration, async () => {
  const source = await setup('imports');
  await resources.importResource('imports', 'skills', join(source, 'skills', 'demo'), 'owned-demo');
  await resources.createContext('imports', 'rules', '# Project rules');
  let state = await resources.inventory('imports');
  const owned = state.resources.find(r => r.owned && r.type === 'skills');
  assert.ok(owned);
  await resources.toggleResource('imports', owned.id, false);
  assert.equal((await resources.inventory('imports')).resources.find(r => r.id === owned.id).enabled, false);
  await resources.writeResource('imports', owned.id, '---\nname: demo\ndescription: Edited\n---\n# Edited');
  assert.equal((await readFile(join(source, 'skills/demo/SKILL.md'), 'utf8')).includes('# Demo'), true);
  const context = state.resources.find(r => r.type === 'context');
  await resources.toggleResource('imports', context.id, false);
  assert.equal((await core.getMetadata('imports')).contexts[0].enabled, false);
  await resources.removeResource('imports', owned.id);
  assert.equal((await resources.inventory('imports')).resources.some(r => r.id === owned.id), false);
  await assert.rejects(resources.importResource('imports', 'context', join(source, 'extensions/demo.js')), /Invalid file type/);
});

test('symlink imports rejected without partially adopting resources', integration, async () => {
  const source = await setup('links');
  await symlink(join(source, 'extensions/demo.js'), join(source, 'skills/demo/unsafe.js'));
  await assert.rejects(resources.importResource('links', 'skills', join(source, 'skills/demo'), 'unsafe'), /Symlink/);
  assert.equal((await core.getSettings('links')).skills.length, 0);
});

test('profile copy leaves credentials, sessions and installation files behind', integration, async () => {
  await setup('original');
  await resources.createContext('original', 'rules', 'Copy these instructions');
  await writeFile(join(core.profilePath('original'), 'auth.json'), '{"secret":"do not copy"}');
  await core.copyProfile('original', 'copy');
  const copied = await resources.inventory('copy');
  assert.equal(copied.resources.find(r => r.type === 'context').name, 'rules');
  assert.equal((await resources.previewResource('copy', copied.resources.find(r => r.type === 'context').id)).text, 'Copy these instructions');
  await assert.rejects(readFile(join(core.profilePath('copy'), 'auth.json')), /ENOENT/);
});
