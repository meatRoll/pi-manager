import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-migration-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
const core = await import('../src/core.js');
const { migratePiPackages, sourcePiAgentDir } = await import('../src/migration.js');
const { packageVersions } = await import('../src/packages.js');
const { publishBundle, BUNDLE_DIR } = await import('../src/bundle.js');
const { validateGeneration, generationPath } = await import('../src/generations.js');
const { inventory, toggleResource } = await import('../src/resources.js');
after(() => rm(temp, { recursive: true, force: true }));

async function packageAt(root: string, name: string) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0', pi: { extensions: ['./index.js'] } }));
  // File discovery must not execute extension code.
  await writeFile(join(root, 'index.js'), 'throw new Error("migration must not execute extensions");');
}

async function candidateDirs(profile: string) {
  return readdir(join(core.profilePath(profile), '.packages')).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

test('import six declarations offline, preserve filters and originals, skip manager, and publish detached files', async () => {
  const source = join(temp, 'source-agent');
  const npm = join(source, 'npm/node_modules/one');
  const external = join(source, 'local-tool');
  await packageAt(npm, 'one');
  await writeFile(join(source, 'npm/package.json'), JSON.stringify({ name: 'source', dependencies: { one: '1.0.0' } }));
  const gitSources = ['git:github.com/acme/two', 'https://github.com/acme/three', 'git:https://github.com/acme/four', 'git:github.com/acme/five'];
  for (const name of ['two', 'three', 'four', 'five']) await packageAt(join(source, 'git/github.com/acme', name), `@upstream/${name}`);
  await packageAt(external, 'local-tool');
  const managerDeclaration = relative(source, BUNDLE_DIR);
  const npmEntry = { source: 'npm:one', skills: [], extensions: ['+index.js'] };
  const sourceText = JSON.stringify({
    packages: [npmEntry, ...gitSources, 'local-tool', managerDeclaration],
    npmCommand: ['npm', '--offline'], httpProxy: 'http://proxy.invalid',
    defaultModel: 'must-not-import', extensions: ['./must-not-import.ts'],
  });
  await writeFile(join(source, 'settings.json'), sourceText);
  for (const name of ['auth.json', 'models.json', 'AGENTS.md']) await writeFile(join(source, name), 'must-not-copy');
  await mkdir(join(source, 'sessions')); await writeFile(join(source, 'sessions/session.jsonl'), 'must-not-copy');
  await core.createProfile('mine');
  const metadataBefore = await readFile(join(core.profilePath('mine'), 'manager.json'), 'utf8');
  const result = await migratePiPackages('mine', source);
  assert.deepEqual(result.imported, ['npm:one', ...gitSources, external]);
  assert.deepEqual(result.skipped, [managerDeclaration]);
  assert.deepEqual(result.externalLocal, [external]);
  const settings = await core.getSettings('mine');
  assert.deepEqual(settings.packages, [npmEntry, ...gitSources, external]);
  assert.deepEqual(settings.npmCommand, ['npm', '--offline']);
  assert.equal(settings.httpProxy, 'http://proxy.invalid');
  assert.equal(settings.defaultModel, undefined);
  assert.deepEqual(settings.extensions, []);
  assert.deepEqual(await packageVersions('mine'), { active: result.generation, previous: null });
  const raw = JSON.parse(await readFile(join(core.profilePath('mine'), 'settings.json'), 'utf8'));
  assert.equal(Object.keys(raw.piManagerPackages.bindings).length, 5);
  assert.equal(raw.packages[0].source, raw.piManagerPackages.bindings['npm:one']);
  assert.equal(raw.packages.at(-1), external);
  assert.ok(!Object.hasOwn(raw.piManagerPackages.bindings, external));
  assert.equal(await readFile(join(core.profilePath('mine'), 'manager.json'), 'utf8'), metadataBefore);
  const generation = generationPath(core.profilePath('mine'), result.generation);
  assert.equal((await validateGeneration(core.profilePath('mine'), result.generation)).command, 'migrate');
  for (const name of ['auth.json', 'models.json', 'AGENTS.md', 'sessions']) await assert.rejects(stat(join(generation, name)), { code: 'ENOENT' });
  const current = await inventory('mine');
  assert.equal(current.packages.length, 6);
  assert.equal(current.resources.length, 6);
  const labels = ['one', 'acme/two', 'acme/three', 'acme/four', 'acme/five', 'local-tool'];
  assert.deepEqual(current.resources.map(resource => resource.displayName).sort(), labels.map(name => `${name} · index.js`).sort());
  assert.deepEqual(current.packages.map(pkg => pkg.displayName), labels);
  assert.equal(current.packages.find(pkg => pkg.source === gitSources[0])?.name, '@upstream/two');
  assert.equal(current.resources.find(item => item.source === 'npm:one')?.name, 'index.js');
  assert.equal(current.resources.find(item => item.source === external)?.path, join(external, 'index.js'));
  const gitResource = current.resources.find(resource => resource.source === gitSources[0]); assert.ok(gitResource);
  assert.equal(gitResource.displayName, 'acme/two · index.js');
  await toggleResource('mine', gitResource.id, false);
  const toggled = await inventory('mine');
  assert.equal(toggled.resources.find(resource => resource.id === gitResource.id)?.enabled, false);
  assert.equal(toggled.resources.find(resource => resource.id === gitResource.id)?.source, gitSources[0]);
  assert.deepEqual((await core.getSettings('mine')).packages?.[1], { source: gitSources[0], extensions: ['-index.js'] });
  await toggleResource('mine', gitResource.id, true);
  assert.equal((await inventory('mine')).resources.find(resource => resource.id === gitResource.id)?.enabled, true);
  await publishBundle('mine');
  const manifest = JSON.parse(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'));
  assert.equal(manifest.piManager.profile, 'mine');
  assert.equal(manifest.pi.extensions.length, 7);
  assert.ok(manifest.pi.extensions.includes(join(external, 'index.js')));
  assert.ok(manifest.pi.extensions.includes(join(BUNDLE_DIR, '.snapshots', manifest.piManager.id, 'npm/node_modules/one/index.js')));
  // Source, candidate and publication never share hardlinks or writable files.
  await writeFile(join(npm, 'index.js'), 'source changed');
  assert.match(await readFile(join(generation, 'npm/node_modules/one/index.js'), 'utf8'), /must not execute/);
  assert.match(await readFile(join(BUNDLE_DIR, '.snapshots', manifest.piManager.id, 'npm/node_modules/one/index.js'), 'utf8'), /must not execute/);
  assert.equal(await readFile(join(source, 'settings.json'), 'utf8'), sourceText);
  assert.equal(await readFile(join(external, 'index.js'), 'utf8'), 'throw new Error("migration must not execute extensions");');
  assert.equal(await readFile(join(source, 'auth.json'), 'utf8'), 'must-not-copy');
});

test('refuse a non-empty profile or an existing generation before changing it', async () => {
  const source = join(temp, 'source-empty'); await mkdir(source);
  await writeFile(join(source, 'settings.json'), JSON.stringify({ packages: ['npm:any'] }));
  await core.createProfile('not-empty');
  const settings = await core.getSettings('not-empty'); settings.packages = ['npm:existing'];
  await core.saveSettings('not-empty', settings);
  const before = await readFile(join(core.profilePath('not-empty'), 'settings.json'), 'utf8');
  await assert.rejects(migratePiPackages('not-empty', source), /already has packages/);
  assert.equal(await readFile(join(core.profilePath('not-empty'), 'settings.json'), 'utf8'), before);
  assert.deepEqual(await candidateDirs('not-empty'), []);
  const migrated = await core.getSettings('mine'); migrated.packages = [];
  await core.saveSettings('mine', migrated);
  await assert.rejects(migratePiPackages('mine', source), /package history/);
});

test('discard failed validation candidates and keep settings and external files unchanged', async () => {
  const source = join(temp, 'missing-agent'); await mkdir(source);
  const sourceText = JSON.stringify({ packages: ['npm:package-not-installed-for-migration'] });
  await writeFile(join(source, 'settings.json'), sourceText);
  await core.createProfile('failed');
  const before = await readFile(join(core.profilePath('failed'), 'settings.json'), 'utf8');
  await assert.rejects(migratePiPackages('failed', source), /candidate discarded/);
  assert.equal(await readFile(join(core.profilePath('failed'), 'settings.json'), 'utf8'), before);
  assert.equal(await readFile(join(source, 'settings.json'), 'utf8'), sourceText);
  assert.deepEqual(await candidateDirs('failed'), []);
  await assert.rejects(stat(join(core.profilePath('failed'), '.lock')), { code: 'ENOENT' });
});

test('skip the actual manager bundle and symlink aliases, not a hard-coded path', async () => {
  const source = join(temp, 'manager-only'); await mkdir(source); await mkdir(BUNDLE_DIR, { recursive: true });
  const alias = join(source, 'manager-alias'); await symlink(BUNDLE_DIR, alias);
  await writeFile(join(source, 'settings.json'), JSON.stringify({ packages: [BUNDLE_DIR, './manager-alias'] }));
  await core.createProfile('only-manager');
  await assert.rejects(migratePiPackages('only-manager', source), /No migratable package declarations/);
  assert.deepEqual(await candidateDirs('only-manager'), []);
});

test('refuse external owned-tree symlinks and source/target overlap', async () => {
  const source = join(temp, 'symlink-agent'); await mkdir(join(source, 'npm/node_modules'), { recursive: true });
  const external = join(temp, 'symlink-external'); await packageAt(external, 'external');
  await symlink(external, join(source, 'npm/node_modules/external'));
  await writeFile(join(source, 'settings.json'), JSON.stringify({ packages: ['npm:external'] }));
  await core.createProfile('symlinks');
  await assert.rejects(migratePiPackages('symlinks', source), /External package symlink/);
  assert.deepEqual(await candidateDirs('symlinks'), []);
  assert.equal(await readFile(join(external, 'index.js'), 'utf8'), 'throw new Error("migration must not execute extensions");');
  await assert.rejects(migratePiPackages('symlinks', core.profilePath('symlinks')), /must not overlap/);
  await assert.rejects(migratePiPackages('symlinks', temp), /must not overlap/);
});

test('source-agent environment selects imports without changing the current Pi agent', () => {
  const before = process.env.PI_MANAGER_SOURCE_AGENT_DIR;
  const agentBefore = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_MANAGER_SOURCE_AGENT_DIR = join(temp, 'custom-agent');
    assert.equal(sourcePiAgentDir(), join(temp, 'custom-agent'));
    assert.equal(process.env.PI_CODING_AGENT_DIR, agentBefore);
  } finally {
    if (before === undefined) delete process.env.PI_MANAGER_SOURCE_AGENT_DIR;
    else process.env.PI_MANAGER_SOURCE_AGENT_DIR = before;
  }
});
