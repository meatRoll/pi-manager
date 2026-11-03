import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-models-cli-')));
const agent = join(root, 'agent');
const home = join(root, 'manager');
const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));
const env = { ...process.env, PI_MANAGER_HOME: home, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', EDITOR: 'true' };
after(() => rm(root, { recursive: true, force: true }));

function command(args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 30000 });
}
function ok(args: string[]) {
  const result = command(args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
function json(args: string[]) { return JSON.parse(ok(args)) as any; }
async function modelsFile() { return JSON.parse(await readFile(join(agent, 'models.json'), 'utf8')) as any; }
async function settingsFile() { return JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')) as any; }

test('models help and an empty summary point at the global Pi files', () => {
  assert.match(ok(['models', '--help']), /manage Pi's global model configuration/);
  assert.match(ok(['models', '--help']), /provider fetch/);
  const summary = ok(['models']);
  assert.match(summary, /models\.json:/);
  assert.match(summary, /settings\.json:/);
  assert.match(summary, /Default:\s+\(not set\)/);
  assert.match(summary, /Enabled:\s+all models/);
  assert.match(ok(['models', 'list']), /models\.json:/);
  assert.deepEqual(json(['models', 'list', '--json']).providers, {});
});

test('provider, model, defaults, enabledModels, and overrides survive a round trip', async () => {
  assert.match(ok(['models', 'provider', 'add', 'local', '--name', 'Local relay', '--base-url', 'https://example.com/v1', '--api', 'openai-completions', '--api-key-env', 'LOCAL_RELAY_KEY', '--header', 'X-Test=yes']), /Provider local added/);
  let list = json(['models', 'list', '--json']);
  assert.equal(list.providers.local.name, 'Local relay');
  assert.equal(list.providers.local.apiKey, '$LOCAL_RELAY_KEY');
  assert.equal(list.providers.local.headers['X-Test'], 'yes');
  assert.equal(json(['models', 'list', '--json', '--reveal']).providers.local.apiKey, '$LOCAL_RELAY_KEY');

  assert.match(ok(['models', 'add', 'local', '--id', 'fast', '--name', 'Fast', '--context-window', '200000', '--max-tokens', '32000', '--reasoning', '--input', 'text,image', '--cost-input', '0.1', '--cost-output', '0.2', '--cost-read', '0.01', '--cost-write', '0.02']), /Model local\/fast added/);
  const shown = json(['models', 'show', 'local', 'fast', '--json']);
  assert.equal(shown.model.name, 'Fast');
  assert.equal(shown.model.contextWindow, 200000);
  assert.equal(shown.model.maxTokens, 32000);
  assert.equal(shown.model.reasoning, true);
  assert.deepEqual(shown.model.input, ['text', 'image']);
  assert.deepEqual(shown.model.cost, { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02 });

  ok(['models', 'update', 'local', 'fast', '--name', 'Faster', '--max-tokens', '64000']);
  assert.equal(json(['models', 'show', 'local', 'fast', '--json']).model.name, 'Faster');
  assert.equal(command(['models', 'update', 'local', 'fast', '--data', '{"id":"other"}']).status, 1);

  assert.match(ok(['models', 'default', 'local', 'fast', '--thinking', 'max']), /Default model updated/);
  assert.deepEqual(await settingsFile(), { defaultProvider: 'local', defaultModel: 'fast', defaultThinkingLevel: 'max' });
  assert.match(ok(['models']), /Default:\s+local\/fast · max/);

  ok(['models', 'enabled', 'add', 'local/*', 'other/*', 'local/*']);
  assert.deepEqual((await settingsFile()).enabledModels, ['local/*', 'other/*']);
  assert.equal(ok(['models', 'enabled', 'list']).trim(), 'local/*\nother/*');
  ok(['models', 'enabled', 'remove', 'other/*']);
  assert.deepEqual((await settingsFile()).enabledModels, ['local/*']);
  ok(['models', 'enabled', 'clear']);
  assert.equal('enabledModels' in await settingsFile(), false);

  ok(['models', 'override', 'set', 'local', 'fast', '--data', '{"contextWindow":100000,"cost":{"input":1}}']);
  let stored = await modelsFile();
  assert.deepEqual(stored.providers.local.modelOverrides.fast, { contextWindow: 100000, cost: { input: 1 } });
  ok(['models', 'override', 'remove', 'local', 'fast', '--yes']);
  stored = await modelsFile();
  assert.equal(stored.providers.local.modelOverrides, undefined);

  assert.equal(command(['models', 'remove', 'local', 'fast']).status, 1);
  assert.match(ok(['models', 'remove', 'local', 'fast', '--yes']), /Model local\/fast removed/);
  stored = await modelsFile();
  assert.equal(stored.providers.local.models, undefined);
  assert.equal(stored.providers.local.baseUrl, 'https://example.com/v1');

  assert.equal(command(['models', 'provider', 'remove', 'local']).status, 1);
  assert.match(ok(['models', 'provider', 'remove', 'local', '--yes']), /Provider local removed/);
  assert.deepEqual(await modelsFile(), { providers: {} });
});

test('defaults can be cleared and one-sided defaults are rejected', async () => {
  ok(['models', 'provider', 'add', 'p', '--base-url', 'https://example.com/v1', '--api', 'openai-completions']);
  ok(['models', 'add', 'p', '--id', 'm']);
  ok(['models', 'default', 'p', 'm', '--thinking', 'high']);
  assert.match(ok(['models', 'default', '--clear']), /Default model updated/);
  assert.deepEqual(await settingsFile(), {});
  assert.match(ok(['models', 'default', '--clear', '--thinking', 'low']), /Default model updated/);
  assert.deepEqual(await settingsFile(), { defaultThinkingLevel: 'low' });
  assert.equal(command(['models', 'default', 'p', 'm', '--thinking', 'turbo']).status, 1);
  assert.equal(command(['models', 'default', 'missing', 'm']).status, 0);
});

test('validation reports broken files and refuses unknown options', async () => {
  ok(['models', 'provider', 'add', 'v', '--base-url', 'https://example.com/v1', '--api', 'openai-completions']);
  assert.match(ok(['models', 'validate']), /models\.json: OK/);
  assert.equal(command(['models', 'list', '--bogus']).status, 1);
  assert.equal(command(['models', 'provider', 'add', 'q']).status, 1);
  assert.match(ok(['models', 'show', 'v']), /baseUrl/);
  assert.equal(command(['models', 'show', 'v', 'missing']).status, 1);
  assert.equal(command(['models', 'provider', 'test', 'v', '--yes', '--url', 'not a url']).status, 1);
});
