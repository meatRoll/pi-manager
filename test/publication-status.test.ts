import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-publication-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
const core = await import('../src/core.js');
const { inventory, createContext, toggleResource, writeResource } = await import('../src/resources.js');
const { publishBundle, BUNDLE_DIR } = await import('../src/bundle.js');
const { createPublicationInspector } = await import('../src/publication-status.js');
const { togglePackage } = await import('../src/packages.js');
after(() => rm(temp, { recursive: true, force: true }));

test('publication status detects prior context/skill edits and switches without publishing or changing files', async () => {
  await core.createProfile('preset');
  const root = core.profilePath('preset');
  const skills = join(root, 'resources/skills/demo'); await mkdir(skills, { recursive: true });
  await writeFile(join(skills, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n# Demo');
  await writeFile(join(skills, 'helper.txt'), 'supporting file one');
  const settings = await core.getSettings('preset'); settings.skills = ['resources/skills/demo']; await core.saveSettings('preset', settings);
  await createContext('preset', 'z-first', 'first'); await createContext('preset', 'a-second', 'second');
  const inspect = createPublicationInspector();
  assert.equal(await inspect(await inventory('preset'), null), 'unpublished');
  const published = await publishBundle('preset');
  const before = await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8');
  assert.equal(await inspect(await inventory('preset'), published), 'published'); // metadata order, not alphabetical
  const context = (await inventory('preset')).resources.find(resource => resource.name === 'z-first'); assert.ok(context);
  await writeResource('preset', context.id, 'changed in an earlier invocation');
  assert.equal(await createPublicationInspector()(await inventory('preset'), published), 'unpublished');
  await writeResource('preset', context.id, 'first');
  const skill = (await inventory('preset')).resources.find(resource => resource.type === 'skills'); assert.ok(skill);
  await toggleResource('preset', skill.id, false);
  assert.equal(await inspect(await inventory('preset'), published), 'unpublished');
  await toggleResource('preset', skill.id, true);
  assert.equal(await inspect(await inventory('preset'), published), 'published');
  await writeFile(join(skills, 'helper.txt'), 'supporting file two');
  assert.equal(await inspect(await inventory('preset'), published), 'unpublished');
  await writeFile(join(skills, 'helper.txt'), 'supporting file one');
  assert.equal(await inspect(await inventory('preset'), published), 'published');
  assert.equal(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'), before);
  await toggleResource('preset', skill.id, false);
  const disabledPublication = await publishBundle('preset');
  assert.equal(await inspect(await inventory('preset'), disabledPublication), 'published');
  await writeFile(join(skills, 'helper.txt'), 'disabled skill was edited too');
  assert.equal(await inspect(await inventory('preset'), disabledPublication), 'unpublished');
});

test('publication status covers package dependency bytes and filters but treats local packages as references', async () => {
  await core.createProfile('packages');
  const root = core.profilePath('packages');
  const owned = join(root, 'npm/node_modules/fixture'); await mkdir(owned, { recursive: true });
  await writeFile(join(owned, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', pi: { extensions: ['./index.js'] } }));
  await writeFile(join(owned, 'index.js'), 'throw new Error("must not execute");');
  await writeFile(join(owned, 'helper.js'), 'dependency one');
  await writeFile(join(root, 'npm/package.json'), JSON.stringify({ dependencies: { fixture: '1.0.0' } }));
  const external = join(temp, 'external'); await mkdir(external);
  await writeFile(join(external, 'package.json'), JSON.stringify({ name: 'external', pi: { extensions: ['./index.js'] } }));
  await writeFile(join(external, 'index.js'), 'throw new Error("external must not execute");');
  const settings = await core.getSettings('packages'); settings.packages = ['npm:fixture', external]; await core.saveSettings('packages', settings);
  const published = await publishBundle('packages');
  const inspect = createPublicationInspector();
  const current = await inventory('packages');
  assert.equal(await inspect(current, published), 'published');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inspect(current, published, controller.signal), { name: 'AbortError' });
  const during = new AbortController();
  const pending = createPublicationInspector()(current, published, during.signal);
  during.abort(); await assert.rejects(pending, { name: 'AbortError' });
  await togglePackage('packages', 'npm:fixture', false);
  assert.equal(await inspect(await inventory('packages'), published), 'unpublished');
  await togglePackage('packages', 'npm:fixture', true);
  assert.equal(await inspect(await inventory('packages'), published), 'published');
  await writeFile(join(owned, 'helper.js'), 'dependency two');
  assert.equal(await inspect(await inventory('packages'), published), 'unpublished');
  await writeFile(join(owned, 'helper.js'), 'dependency one');
  await writeFile(join(external, 'index.js'), 'external edited in place');
  assert.equal(await inspect(await inventory('packages'), published), 'published');
  assert.equal(await inspect(await inventory('packages'), { ...published, id: 'concurrent-publisher' }), 'unknown');
  await rm(join(BUNDLE_DIR, '.snapshots', published.id, 'settings.json'));
  assert.equal(await inspect(await inventory('packages'), published), 'unknown');
});

test('a checkout that drifted from its pinned commit reads as unpublished', async () => {
  const { execFileSync } = await import('node:child_process');
  const git = (root: string, ...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
  await core.createProfile('drift');
  const root = core.profilePath('drift');
  const generationId = '1793585415868-3ac11a4a-90ea-40ca-99d1-af18ae477954';
  const checkout = join(root, '.packages', generationId, 'git/github.com/acme/demo');
  await mkdir(checkout, { recursive: true });
  await writeFile(join(checkout, 'package.json'), JSON.stringify({ name: 'demo', pi: { extensions: ['./index.js'] } }));
  await writeFile(join(checkout, 'index.js'), 'export {};\n');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'one']]) git(checkout, ...args);
  const pinned = git(checkout, 'rev-parse', 'HEAD');
  const settings = await core.getSettings('drift');
  settings.packages = ['git:github.com/acme/demo'];
  settings.piManagerPackages = {
    format: 1, active: generationId, disabledPackages: {},
    bindings: { 'git:github.com/acme/demo': checkout },
  };
  await core.saveSettings('drift', settings);
  const published = await publishBundle('drift');
  const inspect = createPublicationInspector();

  // Freshly published with no checkout installed yet: Pi will install the pin.
  process.env.PI_CODING_AGENT_DIR = join(temp, 'drift-agent');
  assert.equal(await inspect(await inventory('drift'), published), 'published');

  // Pi's own copy at the pinned commit is still published state. It is a copy of
  // the same history, so its HEAD is the pinned commit.
  const installed = join(temp, 'drift-agent', 'git', 'github.com', 'acme', 'demo');
  await cp(checkout, installed, { recursive: true });
  assert.equal(git(installed, 'rev-parse', 'HEAD'), pinned);
  assert.equal(await inspect(await inventory('drift'), published), 'published');

  // A later commit in Pi's copy no longer matches the publication.
  git(installed, 'commit', '--allow-empty', '-m', 'ahead');
  assert.notEqual(git(installed, 'rev-parse', 'HEAD'), pinned);
  assert.equal(await inspect(await inventory('drift'), published), 'unpublished');
});
