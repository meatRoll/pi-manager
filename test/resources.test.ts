import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expectDefined } from './helpers.js';

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

async function setup(name: string) {
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
  const skill = expectDefined(current.resources.find(r => r.type === 'skills'));
  assert.equal(skill.packageRoot, source);
  assert.equal(skill.owned, false);
  assert.equal(skill.displayName, skill.name);
  assert.equal(current.resources.find(resource => resource.name === 'a.md')?.displayName, 'a.md');
  assert.equal((await resources.previewResource('inventory', skill.id)).text.includes('# Demo'), true);
  await assert.rejects(resources.removeResource('inventory', skill.id), /Cannot delete/);
});

test('extension display labels distinguish packages and paths without changing names, IDs or filters', integration, async () => {
  await core.createProfile('labels');
  const packageAt = async (directory: string, name: string | undefined, entries: string[]) => {
    const root = join(temp, directory);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name, pi: { extensions: entries } }));
    for (const entry of entries) {
      const path = join(root, entry);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'throw new Error("MUST NOT EXECUTE FOR LABELS");');
    }
    return root;
  };
  const alpha = await packageAt('labels-alpha', 'alpha-package', ['src/index.ts', 'other/index.ts']);
  const beta = await packageAt('labels-beta', '@scope/beta-package', ['index.ts']);
  const unnamed = await packageAt('labels-unnamed', undefined, ['index.ts']);
  const noManifest = join(temp, 'labels-no-manifest');
  await mkdir(noManifest);
  await writeFile(join(noManifest, 'index.js'), 'throw new Error("MUST NOT EXECUTE WITHOUT MANIFEST");');
  const settings = await core.getSettings('labels');
  settings.packages = [alpha, beta, unnamed, noManifest];
  await core.saveSettings('labels', settings);
  const standalone = join(temp, 'handoff.ts');
  await writeFile(standalone, 'throw new Error("MUST NOT EXECUTE STANDALONE");');
  const owned = await resources.importResource('labels', 'extensions', standalone);
  const settingsPath = join(core.profilePath('labels'), 'settings.json');
  const before = await readFile(settingsPath, 'utf8');
  const current = await resources.inventory('labels');
  const at = (path: string) => expectDefined(current.resources.find(resource => resource.path === path));
  const a = at(join(alpha, 'src/index.ts'));
  const sibling = at(join(alpha, 'other/index.ts'));
  assert.equal(a.name, 'index.ts');
  assert.equal(a.displayName, 'alpha-package · src/index.ts');
  assert.equal(sibling.displayName, 'alpha-package · other/index.ts');
  assert.equal(at(join(beta, 'index.ts')).displayName, '@scope/beta-package · index.ts');
  assert.equal(at(join(unnamed, 'index.ts')).displayName, `${unnamed} · index.ts`);
  assert.equal(at(noManifest).displayName, `${noManifest} · .`);
  assert.equal(at(owned).displayName, 'handoff.ts');
  assert.equal(at(owned).owned, true);
  assert.equal(a.id, createHash('sha256').update(`extensions\0${alpha}\0${a.path}`).digest('hex').slice(0, 12));
  assert.equal((await resources.previewResource('labels', a.id)).text, 'throw new Error("MUST NOT EXECUTE FOR LABELS");');
  assert.equal(await readFile(settingsPath, 'utf8'), before); // labels are read-only metadata
  await resources.toggleResource('labels', a.id, false);
  assert.deepEqual((await core.getSettings('labels')).packages, [
    { source: alpha, extensions: ['-src/index.ts'] }, beta, unnamed, noManifest,
  ]);
  const toggled = await resources.inventory('labels');
  assert.equal(expectDefined(toggled.resources.find(resource => resource.id === a.id)).enabled, false);
  assert.equal(expectDefined(toggled.resources.find(resource => resource.id === sibling.id)).enabled, true);
  assert.equal(expectDefined(toggled.resources.find(resource => resource.source === beta)).enabled, true);
  await writeFile(join(alpha, 'package.json'), JSON.stringify({ name: 'renamed-package', pi: { extensions: ['src/index.ts', 'other/index.ts'] } }));
  const renamed = expectDefined((await resources.inventory('labels')).resources.find(resource => resource.id === a.id));
  assert.equal(renamed.displayName, 'renamed-package · src/index.ts');
  assert.equal(renamed.name, a.name);
  assert.equal(renamed.path, a.path);
  assert.equal(renamed.enabled, false);
});

test('local Git labels follow origin without changing source, IDs, filters or external files', integration, async () => {
  await core.createProfile('local-origin');
  const source = join(temp, 'local-origin-package'); await mkdir(source);
  const manifest = JSON.stringify({ name: '@upstream/todos', pi: { extensions: ['./index.ts'] } });
  const text = 'throw new Error("MUST NOT EXECUTE LOCAL ORIGIN FIXTURE");';
  await writeFile(join(source, 'package.json'), manifest); await writeFile(join(source, 'index.ts'), text);
  const git = (...args: string[]) => execFileSync('git', ['-C', source, ...args], { stdio: 'pipe' });
  git('init'); git('config', '--local', 'remote.origin.url', 'https://github.com/meatRoll/pi-todos.git');
  const config = await readFile(join(source, '.git/config'), 'utf8');
  const settings = await core.getSettings('local-origin'); settings.packages = [source]; await core.saveSettings('local-origin', settings);
  const settingsPath = join(core.profilePath('local-origin'), 'settings.json'); const before = await readFile(settingsPath, 'utf8');
  const current = await resources.inventory('local-origin');
  const item = expectDefined(current.resources.find(resource => resource.source === source));
  assert.equal(current.packages[0].displayName, 'meatRoll/pi-todos');
  assert.equal(current.packages[0].name, '@upstream/todos');
  assert.equal(item.displayName, 'meatRoll/pi-todos · index.ts');
  assert.equal(item.name, 'index.ts'); assert.equal(item.path, join(source, 'index.ts')); assert.equal(item.owned, false);
  assert.equal(item.id, resources.resourceId('extensions', item.path, source));
  assert.equal(await readFile(settingsPath, 'utf8'), before);
  assert.equal(await readFile(join(source, '.git/config'), 'utf8'), config);
  await resources.toggleResource('local-origin', item.id, false);
  assert.deepEqual((await core.getSettings('local-origin')).packages, [{ source, extensions: ['-index.ts'] }]);
  const toggledSettings = await readFile(settingsPath, 'utf8');
  git('config', '--local', 'remote.origin.url', 'git@github.com:meatRoll/renamed-todos.git');
  const renamed = expectDefined((await resources.inventory('local-origin')).resources.find(resource => resource.id === item.id));
  assert.equal(renamed.displayName, 'meatRoll/renamed-todos · index.ts'); assert.equal(renamed.enabled, false);
  assert.equal(renamed.source, source); assert.equal(renamed.path, item.path);
  git('config', '--local', '--unset', 'remote.origin.url');
  const fallback = expectDefined((await resources.inventory('local-origin')).resources.find(resource => resource.id === item.id));
  assert.equal(fallback.displayName, '@upstream/todos · index.ts'); assert.equal(fallback.enabled, false);
  assert.equal(await readFile(settingsPath, 'utf8'), toggledSettings);
  assert.equal(await readFile(join(source, 'package.json'), 'utf8'), manifest);
  assert.equal(await readFile(join(source, 'index.ts'), 'utf8'), text);
});

test('inventory cancellation rejects without executing extensions or changing profile files', integration, async () => {
  await setup('cancel-discovery');
  const path = join(core.profilePath('cancel-discovery'), 'settings.json');
  const before = await readFile(path, 'utf8');
  const controller = new AbortController();
  const pending = resources.inventory('cancel-discovery', { signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(resources.inventory('cancel-discovery', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(await readFile(path, 'utf8'), before);
});

test('per-resource toggles preserve sibling state and respect whole-package disable', integration, async () => {
  const source = await setup('toggles');
  let state = await resources.inventory('toggles');
  const a = expectDefined(state.resources.find(r => r.name === 'a.md'));
  const b = expectDefined(state.resources.find(r => r.name === 'b.md'));
  await resources.toggleResource('toggles', a.id, false);
  state = await resources.inventory('toggles');
  assert.equal(expectDefined(state.resources.find(r => r.id === a.id)).enabled, false);
  assert.equal(expectDefined(state.resources.find(r => r.id === b.id)).enabled, true);
  await togglePackage('toggles', source, false);
  state = await resources.inventory('toggles');
  assert.equal(state.resources.some(r => r.origin === 'package' && r.enabled), false);
  await togglePackage('toggles', source, true);
  state = await resources.inventory('toggles');
  assert.equal(expectDefined(state.resources.find(r => r.id === a.id)).enabled, false);
  assert.equal(expectDefined(state.resources.find(r => r.id === b.id)).enabled, true);
  const settings = await core.getSettings('toggles');
  const entry = expectDefined(settings.packages?.[0]);
  assert.notEqual(typeof entry, 'string');
  if (typeof entry === 'string') throw new Error('Expected resource filters');
  entry.prompts = [];
  await core.saveSettings('toggles', settings);
  await resources.toggleResource('toggles', a.id, true);
  state = await resources.inventory('toggles');
  assert.equal(expectDefined(state.resources.find(r => r.id === a.id)).enabled, true);
  assert.equal(expectDefined(state.resources.find(r => r.id === b.id)).enabled, false);
});

test('copy imports skills and context; edit/delete never touch source files', integration, async () => {
  const source = await setup('imports');
  await resources.importResource('imports', 'skills', join(source, 'skills', 'demo'), 'owned-demo');
  await resources.createContext('imports', 'rules', '# Project rules');
  let state = await resources.inventory('imports');
  const owned = state.resources.find(r => r.owned && r.type === 'skills');
  assert.ok(owned);
  await resources.toggleResource('imports', owned.id, false);
  assert.equal(expectDefined((await resources.inventory('imports')).resources.find(r => r.id === owned.id)).enabled, false);
  await resources.writeResource('imports', owned.id, '---\nname: demo\ndescription: Edited\n---\n# Edited');
  assert.equal((await readFile(join(source, 'skills/demo/SKILL.md'), 'utf8')).includes('# Demo'), true);
  const context = expectDefined(state.resources.find(r => r.type === 'context'));
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
  assert.equal((await core.getSettings('links')).skills?.length, 0);
});

test('profile copy leaves credentials, sessions and installation files behind', integration, async () => {
  await setup('original');
  await resources.createContext('original', 'rules', 'Copy these instructions');
  await writeFile(join(core.profilePath('original'), 'auth.json'), '{"secret":"do not copy"}');
  await core.copyProfile('original', 'copy');
  const copied = await resources.inventory('copy');
  const context = expectDefined(copied.resources.find(r => r.type === 'context'));
  assert.equal(context.name, 'rules');
  assert.equal(context.displayName, 'rules');
  assert.equal((await resources.previewResource('copy', context.id)).text, 'Copy these instructions');
  await assert.rejects(readFile(join(core.profilePath('copy'), 'auth.json')), /ENOENT/);
});

test('resource origin separates package entries, preset declarations and user-level discoveries', async () => {
  assert.equal(resources.resourceOrigin({ origin: 'package', source: '/any/package' }), 'package');
  assert.equal(resources.resourceOrigin({ origin: 'top-level', source: 'local' }), 'standalone');
  // Pi auto-discovers these from the user's home; a preset never declared them.
  assert.equal(resources.resourceOrigin({ origin: 'top-level', source: 'auto' }), 'global');
  assert.equal(resources.originLabel('global'), 'user-level');
  assert.equal(resources.originLabel('package'), 'package');
  assert.equal(resources.originLabel('standalone'), 'standalone');
});

test('user-level resources cannot be toggled from a preset', integration, async () => {
  const state = await resources.inventory('toggles');
  const userLevel = state.resources.find(resource => resource.origin === 'global');
  if (!userLevel) return; // no ~/.agents or ~/.claude resources on this machine
  await assert.rejects(resources.toggleResource('toggles', userLevel.id, false), /discovered by Pi itself/);
});
