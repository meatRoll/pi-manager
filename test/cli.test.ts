import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Resource } from '../src/types.js';
import { VERSION } from '../src/version.js';
import { spawnSync } from 'node:child_process';
import { findPiSdk } from '../src/pi-sdk.js';
import { clip, plain } from '../src/terminal.js';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-cli-')));
const home = join(temp, 'manager');
const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));
const env = { ...process.env, PI_MANAGER_HOME: home, PI_OFFLINE: '1' };
let sdk: string | undefined;
try { sdk = findPiSdk(); } catch { /* optional Pi integration */ }
after(() => rm(temp, { recursive: true, force: true }));
function command(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 30000 });
}
function ok(args: string[]) {
  const result = command(args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('help, error exit codes, explicit destructive consent', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(VERSION, manifest.version);
  assert.match(ok(['--help']), /INSIDE Pi/);
  assert.match(ok([]), /Primary interface/);
  assert.equal(command(['install']).status, 1);
  assert.equal(ok(['--version']).trim(), VERSION);
  assert.equal(command(['invalid']).status, 1);
  ok(['profile', 'create', 'review']);
  assert.equal(command(['package', 'add', 'review', 'npm:demo']).status, 1);
  assert.equal(command(['profile', 'delete', 'review']).status, 1);
  assert.equal(command(['profile', 'run', 'review', 'update']).status, 1);
  assert.equal(command(['resource', 'list', 'missing']).status, 1);
});

test('local package lifecycle and resource inventory through real Pi, offline', sdk ? {} : { skip: 'Installed Pi SDK required' }, async () => {
  const source = join(temp, 'fixture');
  await mkdir(join(source, 'skills', 'demo'), { recursive: true });
  await mkdir(join(source, 'prompts'), { recursive: true });
  await mkdir(join(source, 'src'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'local-demo', version: '1.0.0', pi: { skills: ['./skills'], prompts: ['./prompts'], extensions: ['./src/index.ts'] } }));
  await writeFile(join(source, 'src/index.ts'), 'throw new Error("CLI inventory must not execute extensions");');
  await writeFile(join(source, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: A demo\n---\n# Demo');
  await writeFile(join(source, 'prompts/demo.md'), 'Demo prompt');
  ok(['package', 'add', 'review', source, '--yes']);
  let list: Resource[] = JSON.parse(ok(['resource', 'list', 'review', '--json']));
  assert.equal(list.filter(r => r.origin === 'package').length, 3);
  assert.equal(list.find(resource => resource.type === 'extensions')?.name, 'index.ts');
  assert.equal(list.find(resource => resource.type === 'extensions')?.displayName, 'local-demo · src/index.ts');
  assert.match(ok(['resource', 'list', 'review', 'extensions']), /local-demo · src\/index\.ts/);
  ok(['package', 'disable', 'review', source]);
  list = JSON.parse(ok(['resource', 'list', 'review', '--json']));
  assert.equal(list.some(r => r.origin === 'package' && r.enabled), false);
  ok(['package', 'enable', 'review', source]);
  ok(['context', 'create', 'review', 'rules', 'Always describe assumptions.']);
  assert.match(ok(['context', 'preview', 'review', 'rules']), /Always describe/);
  ok(['context', 'disable', 'review', 'rules']);
  ok(['profile', 'copy', 'review', 'second']);
  ok(['package', 'remove', 'review', source, '--yes']);
  assert.equal(JSON.parse(await readFile(join(home, 'profiles/review/settings.json'), 'utf8')).packages.length, 0);
  const versions = JSON.parse(ok(['package', 'versions', 'review']));
  assert.ok(versions.active && versions.previous);
  assert.equal(command(['package', 'rollback', 'review']).status, 1);
  assert.match(ok(['package', 'rollback', 'review', '--yes']), /Restored package generation/);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'profiles/review/settings.json'), 'utf8')).packages, [source]);
  ok(['package', 'remove', 'review', source, '--yes']);
});

test('manager-launched Pi receives context and isolated environment, child status propagates', async () => {
  const capture = join(temp, 'launch.json');
  const fake = join(temp, 'fake-pi');
  await writeFile(fake, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args: process.argv.slice(2), agent: process.env.PI_CODING_AGENT_DIR, sessions: process.env.PI_CODING_AGENT_SESSION_DIR}));process.exit(7);`, { mode: 0o700 });
  const result = spawnSync(process.execPath, [cli, 'profile', 'run', 'review', '--', '--offline'], {
    env: { ...env, PI_MANAGER_PI: fake, PI_CODING_AGENT_SESSION_DIR: '/must-not-use' }, encoding: 'utf8',
  });
  assert.equal(result.status, 7);
  const launch = JSON.parse(await readFile(capture, 'utf8'));
  assert.equal(launch.agent, join(home, 'profiles/review'));
  assert.equal(launch.sessions, join(home, 'profiles/review/sessions'));
  assert.ok(launch.args.includes('--no-approve'));
  assert.ok(!launch.args.includes('--append-system-prompt')); // disabled above
  if (sdk) {
    ok(['context', 'enable', 'review', 'rules']);
    spawnSync(process.execPath, [cli, 'profile', 'run', 'review', '--', '--offline'], {
      env: { ...env, PI_MANAGER_PI: fake }, encoding: 'utf8',
    });
    const enabled = JSON.parse(await readFile(capture, 'utf8'));
    assert.ok(enabled.args.includes('--append-system-prompt'));
    assert.ok(enabled.args.includes(join(home, 'profiles/review/resources/context/rules.md')));
  }
});

test('default Pi and project settings unchanged by real offline package operations', sdk ? {} : { skip: 'Installed Pi SDK required' }, async () => {
  const fakeHome = join(temp, 'user-home');
  const project = join(temp, 'project');
  await mkdir(join(fakeHome, '.pi/agent'), { recursive: true });
  await mkdir(join(project, '.pi'), { recursive: true });
  const sentinel = '{"sentinel":"must-not-change","packages":[]}\n';
  const globalSettings = join(fakeHome, '.pi/agent/settings.json');
  const projectSettings = join(project, '.pi/settings.json');
  await writeFile(globalSettings, sentinel);
  await writeFile(projectSettings, sentinel);
  const result = spawnSync(process.execPath, [cli, 'package', 'add', 'review', join(temp, 'fixture'), '--yes'], {
    cwd: project, env: { ...env, HOME: fakeHome, PI_MANAGER_SDK_PATH: sdk }, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(globalSettings, 'utf8'), sentinel);
  assert.equal(await readFile(projectSettings, 'utf8'), sentinel);
});

test('migrate CLI requires consent and imports into an empty staging profile without touching source settings', sdk ? {} : { skip: 'Installed Pi SDK required' }, async () => {
  const source = join(temp, 'import-agent');
  await mkdir(source);
  const sourceText = JSON.stringify({ packages: ['../fixture', join(home, 'pi-package')] });
  await writeFile(join(source, 'settings.json'), sourceText);
  ok(['profile', 'create', 'imported']);
  assert.match(command(['migrate', 'imported', source]).stderr, /--yes/);
  assert.equal(command(['migrate', 'imported', source, 'unexpected', '--yes']).status, 1);
  const output = ok(['migrate', 'imported', source, '--yes']);
  assert.match(output, /Imported 1 packages/);
  assert.match(output, /Skipped manager bundle/);
  assert.match(output, /Original declarations remain active/);
  assert.equal(await readFile(join(source, 'settings.json'), 'utf8'), sourceText);
  const raw = JSON.parse(await readFile(join(home, 'profiles/imported/settings.json'), 'utf8'));
  assert.deepEqual(raw.packages, [join(temp, 'fixture')]);
  assert.ok(raw.piManagerPackages.active);
  assert.equal(command(['migrate', 'imported', source, '--yes']).status, 1);
});

test('terminal strips control sequences from package/log content', () => {
  assert.equal(plain('\x1b[2JHello\x1b]0;malicious\x07'), 'Hello');
  assert.equal(clip('中文abc', 5), '中文a');
});

test('installer recognises an existing manager package declaration before adding one', async () => {
  const { hasManagerPackage } = await import('../src/install-pi.js');
  const agent = join(temp, 'agent-settings'); await mkdir(agent, { recursive: true });
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ packages: ['../manager/pi-package'] }));
  assert.equal(await hasManagerPackage(agent), false);
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ packages: ['git:github.com/meatRoll/pi-manager', '../manager/pi-package'] }));
  assert.equal(await hasManagerPackage(agent), true);
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ packages: [{ source: 'git:https://github.com/meatRoll/pi-manager.git' }] }));
  assert.equal(await hasManagerPackage(agent), true);
  await writeFile(join(agent, 'settings.json'), 'not json');
  assert.equal(await hasManagerPackage(agent), false);
});
