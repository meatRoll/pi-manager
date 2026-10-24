// Real npm install/remove against an in-process loopback registry. No external
// network, credentials, model calls or default npm/Pi config changes are needed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { findPiSdk } from '../src/pi-sdk.js';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-npm-generations-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
const core = await import('../src/core.js');
const { packageOperation, rollbackPackages } = await import('../src/packages.js');
const { inventory } = await import('../src/resources.js');
const { PACKAGE_STATE_KEY } = await import('../src/package-state.js');
let sdk; try { sdk = findPiSdk(); } catch {}
after(() => rm(temp, { recursive: true, force: true }));

test('real npm packages install in candidates, replace versions, remove and restore without downloads', sdk ? {} : { skip: 'Pi SDK required' }, async () => {
  const tarballs: Record<string, Buffer> = {};
  for (const version of ['1.0.0', '2.0.0']) {
    const directory = join(temp, version); const pkg = join(directory, 'package');
    await mkdir(join(pkg, 'prompts'), { recursive: true });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'generation-fixture', version, pi: { prompts: ['./prompts'] } }));
    await writeFile(join(pkg, 'prompts/demo.md'), `content ${version}`);
    const archive = join(directory, 'fixture.tgz');
    const packed = spawnSync('tar', ['-czf', archive, '-C', directory, 'package']);
    assert.equal(packed.status, 0);
    tarballs[version] = await readFile(archive);
  }
  let origin: string;
  const server = createServer((request, response) => {
    const path = new URL(request.url || '/', origin).pathname;
    const archive = Object.entries(tarballs).find(([version]) => path === `/generation-fixture/-/${version}.tgz`);
    if (archive) { response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.end(archive[1]); return; }
    if (path !== '/generation-fixture') { response.writeHead(404); response.end('{}'); return; }
    const versions = Object.fromEntries(Object.entries(tarballs).map(([version, buffer]) => [version, {
      name: 'generation-fixture', version, pi: { prompts: ['./prompts'] },
      dist: { tarball: `${origin}/generation-fixture/-/${version}.tgz`, shasum: createHash('sha1').update(buffer).digest('hex') },
    }]));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ name: 'generation-fixture', 'dist-tags': { latest: '2.0.0' }, versions }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  try {
    await core.createProfile('real-npm');
    const settings = await core.getSettings('real-npm');
    settings.npmCommand = ['npm', `--registry=${origin}`, `--cache=${join(temp, 'npm-cache')}`, '--ignore-scripts', '--no-audit', '--no-fund'];
    await core.saveSettings('real-npm', settings);
    const options = { env: { http_proxy: '', https_proxy: '', all_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' } };
    await packageOperation('real-npm', 'add', 'npm:generation-fixture@1.0.0', options);
    const initial = await inventory('real-npm');
    assert.equal(initial.packages[0].version, '1.0.0');
    const firstPath = initial.packages[0].installedPath;
    assert.ok(firstPath);
    await packageOperation('real-npm', 'add', 'npm:generation-fixture@2.0.0', options);
    assert.equal((await inventory('real-npm')).packages[0].version, '2.0.0');
    assert.equal(await readFile(join(firstPath, 'prompts/demo.md'), 'utf8'), 'content 1.0.0');
    const { togglePackage } = await import('../src/packages.js');
    await togglePackage('real-npm', 'npm:generation-fixture@2.0.0', false);
    await packageOperation('real-npm', 'add', 'npm:generation-fixture@1.0.0', options);
    assert.equal((await inventory('real-npm')).packages[0].enabled, false);
    await togglePackage('real-npm', 'npm:generation-fixture@1.0.0', true);
    await packageOperation('real-npm', 'add', 'npm:generation-fixture@2.0.0', options);
    await packageOperation('real-npm', 'remove', 'npm:generation-fixture@2.0.0', options);
    assert.deepEqual((await core.getSettings('real-npm')).packages, []);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); // restore must not need this registry
    await rollbackPackages('real-npm');
    assert.equal((await inventory('real-npm')).packages[0].version, '2.0.0');
    const raw = JSON.parse(await readFile(join(core.profilePath('real-npm'), 'settings.json'), 'utf8'));
    assert.equal(raw.packages[0], raw[PACKAGE_STATE_KEY].bindings['npm:generation-fixture@2.0.0']);
  } finally { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
});
