import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-proxy-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
const proxy = await import('../src/proxy.js');
const { runPackageWorker } = await import('../src/generations.js');
const { inspectPackage } = await import('../src/packages.js');
const { selfUpdate } = await import('../src/self-update.js');
after(() => rm(temp, { recursive: true, force: true }));

test('custom proxy URLs are normalized and display credentials redacted', () => {
  assert.equal(proxy.normalizeProxyUrl('127.0.0.1:7897'), 'http://127.0.0.1:7897');
  assert.equal(proxy.normalizeProxyUrl('http://127.0.0.1:7897/'), 'http://127.0.0.1:7897');
  assert.equal(proxy.normalizeProxyUrl('socks5://127.0.0.1:7897'), 'socks5://127.0.0.1:7897');
  assert.throws(() => proxy.normalizeProxyUrl('ftp://127.0.0.1:21'), /Unsupported proxy scheme/);
  assert.throws(() => proxy.normalizeProxyUrl('http://127.0.0.1:7897/path'), /must not include a path/);
  assert.equal(proxy.displayProxy('http://user:secret@127.0.0.1:7897'), 'http://user:***@127.0.0.1:7897');
});

test('macOS system proxy parsing keeps HTTP, HTTPS, SOCKS and exceptions', () => {
  const parsed = proxy.parseMacSystemProxy(`<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
    2 : <local>
  }
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7897
  SOCKSProxy : 127.0.0.1
}`);
  assert.equal(parsed?.http, 'http://127.0.0.1:7897');
  assert.equal(parsed?.https, 'https://127.0.0.1:7897');
  assert.equal(parsed?.all, 'socks5://127.0.0.1:7897');
  assert.equal(parsed?.noProxy, '127.0.0.1,localhost,*.local');
  assert.equal(proxy.parseMacSystemProxy('HTTPEnable : 0'), undefined);
});

test('none clears ambient proxies and overrides Git config', () => {
  const env = proxy.applyProxyConfig({
    PATH: '/bin', HTTP_PROXY: 'http://ambient:1', https_proxy: 'http://ambient:1',
    NO_PROXY: 'localhost', npm_config_proxy: 'http://ambient:1',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'test',
  }, { mode: 'none' });
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.https_proxy, undefined);
  assert.equal(env.NO_PROXY, undefined);
  assert.equal(env.npm_config_proxy, '');
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(env.GIT_CONFIG_KEY_0, 'user.name');
  assert.equal(env.GIT_CONFIG_KEY_1, 'http.proxy');
  assert.equal(env.GIT_CONFIG_VALUE_1, '');
  assert.equal(env.GIT_CONFIG_KEY_2, 'https.proxy');
  assert.equal(env.GIT_CONFIG_VALUE_2, '');
});

test('custom proxy overrides ambient values for npm, Git and NO_PROXY', () => {
  const env = proxy.applyProxyConfig({ PATH: '/bin', NO_PROXY: 'internal.example' }, {
    mode: 'custom', url: 'http://127.0.0.1:7897',
  });
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    assert.equal(env[key], 'http://127.0.0.1:7897');
  }
  assert.equal(env.NO_PROXY, 'internal.example');
  assert.equal(env.npm_config_proxy, 'http://127.0.0.1:7897');
  assert.equal(env.npm_config_https_proxy, 'http://127.0.0.1:7897');
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.proxy');
  assert.equal(env.GIT_CONFIG_VALUE_0, 'http://127.0.0.1:7897');
  assert.equal(env.GIT_CONFIG_KEY_1, 'https.proxy');
});

test('system mode prefers the ambient proxy and falls back to detected settings', () => {
  const ambient = proxy.applyProxyConfig({ HTTP_PROXY: 'http://ambient:1', NO_PROXY: 'localhost' }, { mode: 'system' }, {
    http: 'http://detected:2', https: 'http://detected:2', all: 'socks5://detected:2',
  });
  assert.equal(ambient.HTTP_PROXY, 'http://ambient:1');
  assert.equal(ambient.HTTPS_PROXY, 'http://ambient:1');
  assert.equal(ambient.GIT_CONFIG_COUNT, '2');
  assert.equal(ambient.GIT_CONFIG_VALUE_0, 'http://ambient:1');

  const detected = proxy.applyProxyConfig({ PATH: '/bin' }, { mode: 'system' }, {
    http: 'http://detected:2', https: 'https://detected:2', all: 'socks5://detected:2', noProxy: 'localhost',
  });
  assert.equal(detected.HTTP_PROXY, 'http://detected:2');
  assert.equal(detected.HTTPS_PROXY, 'https://detected:2');
  assert.equal(detected.ALL_PROXY, 'socks5://detected:2');
  assert.equal(detected.NO_PROXY, 'localhost');
  assert.equal(detected.GIT_CONFIG_COUNT, '2');
});

test('proxy settings persist in manager state and normalize custom URLs', async () => {
  await proxy.setProxySettings({ mode: 'custom', url: '127.0.0.1:7897' });
  assert.deepEqual(await proxy.getProxySettings(), { mode: 'custom', url: 'http://127.0.0.1:7897' });
  await proxy.setProxySettings({ mode: 'system', url: 'http://127.0.0.1:7897' });
  assert.deepEqual(await proxy.getProxySettings(), { mode: 'system', url: 'http://127.0.0.1:7897' });
  await assert.rejects(proxy.setProxySettings({ mode: 'custom' }), /requires a URL/);
});

test('explicit empty proxy overrides suppress system detection', async () => {
  await proxy.setProxySettings({ mode: 'system' });
  const env = await proxy.networkEnvironment({
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '',
    npm_config_proxy: '', npm_config_https_proxy: '',
    NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1',
  });
  assert.equal(env.HTTP_PROXY, '');
  assert.equal(env.npm_config_proxy, '');
});

test('package worker receives the resolved proxy environment', async () => {
  const root = join(temp, 'worker-root'); await mkdir(root, { recursive: true });
  const capture = join(temp, 'worker-env.json');
  const worker = join(temp, 'worker');
  await writeFile(worker, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify(process.env));process.send({settings:{packages:[]}},()=>process.exit(0));`, { mode: 0o700 });
  const custom = proxy.applyProxyConfig({ PATH: process.env.PATH, HOME: process.env.HOME }, { mode: 'custom', url: 'http://127.0.0.1:7897' });
  await runPackageWorker(root, [], { piCommand: worker, env: custom });
  const recorded = JSON.parse(await readFile(capture, 'utf8')) as NodeJS.ProcessEnv;
  assert.equal(recorded.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.equal(recorded.npm_config_https_proxy, 'http://127.0.0.1:7897');
  assert.equal(recorded.GIT_CONFIG_VALUE_0, 'http://127.0.0.1:7897');

  const none = proxy.applyProxyConfig({ PATH: process.env.PATH, HOME: process.env.HOME }, { mode: 'none' });
  await runPackageWorker(root, [], { piCommand: worker, env: none });
  const cleared = JSON.parse(await readFile(capture, 'utf8')) as NodeJS.ProcessEnv;
  assert.equal(cleared.HTTP_PROXY, undefined);
  assert.equal(cleared.npm_config_proxy, '');
  assert.equal(cleared.GIT_CONFIG_VALUE_0, '');
});

async function withFakeCommand(name: string, body: string, operation: () => Promise<void>) {
  const bin = join(temp, `bin-${name}`); await mkdir(bin, { recursive: true });
  await writeFile(join(bin, name), `#!/usr/bin/env node\n${body}`, { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous || ''}`;
  try { await operation(); }
  finally { process.env.PATH = previous; }
}

test('npm inspection and self-update receive the resolved proxy environment', async () => {
  await proxy.setProxySettings({ mode: 'custom', url: 'http://127.0.0.1:7897' });
  const npmCapture = join(temp, 'npm-env.json');
  await withFakeCommand('npm', `require('node:fs').writeFileSync(${JSON.stringify(npmCapture)}, JSON.stringify(process.env));console.log(JSON.stringify({name:'fixture',version:'1.0.0'}));`, async () => {
    const result = await inspectPackage('npm:fixture');
    assert.equal(result.kind, 'npm');
  });
  const npmEnv = JSON.parse(await readFile(npmCapture, 'utf8')) as NodeJS.ProcessEnv;
  assert.equal(npmEnv.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.equal(npmEnv.npm_config_proxy, 'http://127.0.0.1:7897');

  const root = join(temp, 'update-repo'); await mkdir(root, { recursive: true });
  const gitCapture = join(temp, 'git-env.log');
  const script = `const fs=require('node:fs');const args=process.argv.slice(2);const entry=Object.keys(process.env).find(key=>/^GIT_CONFIG_KEY_/.test(key)&&process.env[key]==='http.proxy');const git=entry?process.env[entry.replace('GIT_CONFIG_KEY_','GIT_CONFIG_VALUE_')]:undefined;fs.appendFileSync(${JSON.stringify(gitCapture)},JSON.stringify({args,http:process.env.HTTP_PROXY,git})+'\\n');if(args.includes('--show-toplevel'))console.log(${JSON.stringify(root)});else if(args.includes('get-url'))console.log('https://github.com/meatRoll/pi-manager.git');else if(args.includes('--abbrev-ref'))console.log('main');else if(args.includes('--short'))console.log('abc1234');else if(args.includes('--porcelain'))console.log('');process.exit(0);`;
  await withFakeCommand('git', script, async () => {
    const result = await selfUpdate({ root, republish: false });
    assert.equal(result.changed, false);
  });
  const calls = (await readFile(gitCapture, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[]; http?: string; git?: string });
  assert.ok(calls.length >= 5);
  for (const call of calls) {
    assert.equal(call.http, 'http://127.0.0.1:7897');
    assert.equal(call.git, 'http://127.0.0.1:7897');
  }
  await proxy.setProxySettings({ mode: 'system' });
});
