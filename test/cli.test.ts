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
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'local-demo', version: '1.0.0', pi: { skills: ['./skills'], prompts: ['./prompts'] } }));
  await writeFile(join(source, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: A demo\n---\n# Demo');
  await writeFile(join(source, 'prompts/demo.md'), 'Demo prompt');
  ok(['package', 'add', 'review', source, '--yes']);
  let list: Resource[] = JSON.parse(ok(['resource', 'list', 'review', '--json']));
  assert.equal(list.filter(r => r.origin === 'package').length, 2);
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

test('terminal strips control sequences from package/log content', () => {
  assert.equal(plain('\x1b[2JHello\x1b]0;malicious\x07'), 'Hello');
  assert.equal(clip('中文abc', 5), '中文a');
});
