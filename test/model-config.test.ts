import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_COST, formatTokens, maskSecret, readModels, readSettings, removeModel, removeOverride,
  removeProvider, setDefaultSelection, setEnabledPatterns, setModel, setOverride, setProvider,
  validateModelsValue, validateSettingsValue, writeModels, writeSettings,
} from '../src/model-config.js';

const roots: string[] = [];
async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'pi-manager-model-config-'));
  roots.push(root);
  return root;
}
after(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))));

const validProvider = (overrides: Record<string, unknown> = {}) => ({
  baseUrl: 'https://example.com/v1',
  api: 'openai-completions',
  apiKey: '$TEST_KEY',
  ...overrides,
});
const validModel = (overrides: Record<string, unknown> = {}) => ({
  id: 'model-a',
  name: 'Model A',
  reasoning: true,
  input: ['text', 'image'] as Array<'text' | 'image'>,
  contextWindow: 200000,
  maxTokens: 32000,
  cost: { ...DEFAULT_COST },
  ...overrides,
});

test('models.json validation accepts Pi fields and rejects invalid values', () => {
  assert.deepEqual(validateModelsValue({ providers: {} }), []);
  assert.deepEqual(validateModelsValue({
    providers: {
      p: validProvider({
        models: [validModel()],
        modelOverrides: { 'model-a': { contextWindow: 1000, cost: { input: 1 } } },
        compat: { supportsDeveloperRole: false },
      }),
    },
  }), []);

  assert.match(validateModelsValue({ providers: { p: {} } }).join('\n'), /must specify baseUrl/);
  assert.match(validateModelsValue({ providers: { p: validProvider({ baseUrl: 'not-a-url' }) } }).join('\n'), /http\(s\) URL/);
  assert.match(validateModelsValue({ providers: { 'bad/id': validProvider() } }).join('\n'), /Provider id/);
  assert.match(validateModelsValue({ providers: { p: validProvider({ oauth: 'other' }) } }).join('\n'), /must be "radius"/);
  assert.match(validateModelsValue({ providers: { p: { oauth: 'radius' } } }).join('\n'), /baseUrl is required when oauth is set/);
  assert.match(validateModelsValue({ providers: { p: validProvider({ models: [validModel(), validModel()] }) } }).join('\n'), /duplicates another model/);
  assert.match(validateModelsValue({ providers: { p: validProvider({ models: [validModel({ contextWindow: 0 })] }) } }).join('\n'), /positive integer/);
  assert.match(validateModelsValue({ providers: { p: validProvider({ models: [validModel({ input: ['audio'] })] }) } }).join('\n'), /"text" or "image"/);
  assert.match(validateModelsValue({ providers: { p: validProvider({ headers: { Authorization: 1 } }) } }).join('\n'), /must be a string/);
  assert.match(validateModelsValue({ providers: { p: validProvider({ models: [validModel({ cost: { input: 1 } })] }) } }).join('\n'), /cost\.output is required/);
  assert.match(validateModelsValue({ providers: { p: validProvider({ modelOverrides: { m: { cost: { input: -1 } } } }) } }).join('\n'), /non-negative/);
  assert.deepEqual(validateModelsValue({ providers: { p: validProvider({ modelOverrides: { m: { cost: { input: 1 } } } }) } }), []);
  assert.match(validateModelsValue({ providers: { p: validProvider({ models: [validModel({ thinkingLevelMap: { high: 1 } })] }) } }).join('\n'), /string or null/);
});

test('settings validation checks the four managed keys only', () => {
  assert.deepEqual(validateSettingsValue({ theme: 'dark', defaultProvider: 'p', defaultModel: 'm', defaultThinkingLevel: 'max', enabledModels: ['p/*'] }), []);
  assert.match(validateSettingsValue({ defaultThinkingLevel: 'turbo' }).join('\n'), /one of/);
  assert.match(validateSettingsValue({ enabledModels: ['p/*', ''] }).join('\n'), /non-empty/);
  assert.match(validateSettingsValue([]).join('\n'), /JSON object/);
});

test('models.json writes atomically, backs up, and refuses external changes and symlinks', async () => {
  const root = await temp();
  const agent = join(root, 'agent');
  await mkdir(agent);
  const backupDir = join(root, 'backups');
  const missing = await readModels(agent);
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.value, { providers: {} });

  const first = await writeModels({ providers: { p: validProvider({ models: [validModel()] }) } }, { agentDir: agent, expectedRevision: missing.revision, backupDir });
  assert.equal(first.backup, undefined);
  const loaded = await readModels(agent);
  assert.equal(loaded.error, undefined);
  assert.equal(loaded.value?.providers?.p.models?.[0].id, 'model-a');

  const second = await writeModels({ providers: { p: validProvider({ models: [validModel({ name: 'Changed' })] }) } }, { agentDir: agent, expectedRevision: first.revision, backupDir });
  assert.ok(second.backup);
  assert.match(second.backup!, /models\.json\..*\.bak$/);
  assert.equal((await readFile(second.backup!, 'utf8')).includes('Model A'), true);

  await writeFile(join(agent, 'models.json'), `${JSON.stringify({ providers: {} })}\n`);
  await assert.rejects(
    writeModels({ providers: {} }, { agentDir: agent, expectedRevision: second.revision, backupDir }),
    /changed outside pi-manager/,
  );
  assert.deepEqual(JSON.parse(await readFile(join(agent, 'models.json'), 'utf8')), { providers: {} });

  const target = join(root, 'target.json');
  await writeFile(target, `${JSON.stringify({ providers: {} })}\n`);
  await rm(join(agent, 'models.json'));
  await symlink(target, join(agent, 'models.json'));
  const linked = await readModels(agent);
  await assert.rejects(
    writeModels({ providers: {} }, { agentDir: agent, expectedRevision: linked.revision, backupDir }),
    /symlink/,
  );
});

test('models.json and settings.json accept Pi-style line comments and trailing commas', async () => {
  const root = await temp();
  const agent = join(root, 'agent');
  await mkdir(agent);
  await writeFile(join(agent, 'models.json'), `{
    // a provider comment
    "providers": {
      "p": {
        "baseUrl": "https://example.com/v1",
        "api": "openai-completions",
        "models": [{ "id": "m", "name": "M", }],
      },
    },
  }
`);
  await writeFile(join(agent, 'settings.json'), `{
    "defaultProvider": "p",
    "defaultModel": "m",
    // trailing comma follows
    "enabledModels": ["p/*"],
  }
`);
  const models = await readModels(agent);
  assert.equal(models.error, undefined);
  assert.equal(models.value?.providers?.p.models?.[0].id, 'm');
  assert.equal((await readSettings(agent)).value?.defaultProvider, 'p');
  assert.ok(models.raw.includes('// a provider comment'));
  const result = await writeModels(models.value!, { agentDir: agent, expectedRevision: models.revision, backupDir: join(root, 'backups') });
  assert.ok(result.backup);
  assert.equal((await readModels(agent)).error, undefined);
  assert.equal((await readFile(join(agent, 'models.json'), 'utf8')).includes('// a provider comment'), false);
});

test('models.json rejects invalid writes before touching the file', async () => {
  const root = await temp();
  const agent = join(root, 'agent');
  await mkdir(agent);
  await assert.rejects(writeModels({ providers: { p: {} } }, { agentDir: agent }), /Invalid models.json/);
  await assert.rejects(readFile(join(agent, 'models.json'), 'utf8'), /ENOENT/);
});

test('provider, model, and override CRUD keeps Pi provider entries valid', () => {
  const config = { providers: {} as Record<string, any> };
  setProvider(config, 'p', validProvider());
  setModel(config, 'p', validModel());
  setOverride(config, 'p', 'model-a', { contextWindow: 1000, cost: { input: 1 } });
  assert.equal(config.providers.p.models.length, 1);
  assert.equal(config.providers.p.modelOverrides['model-a'].contextWindow, 1000);

  const replacement = validModel({ name: 'Replacement' });
  setModel(config, 'p', replacement);
  assert.equal(config.providers.p.models.length, 1);
  assert.equal(config.providers.p.models[0].name, 'Replacement');

  removeModel(config, 'p', 'model-a');
  assert.equal(config.providers.p.models, undefined);
  assert.equal(config.providers.p.baseUrl, 'https://example.com/v1');
  removeOverride(config, 'p', 'model-a');
  assert.equal(config.providers.p.modelOverrides, undefined);
  assert.equal(config.providers.p.baseUrl, 'https://example.com/v1');

  const overrideOnly = { providers: {} as Record<string, any> };
  setOverride(overrideOnly, 'builtin', 'model-a', { cost: { input: 1 } });
  assert.deepEqual(overrideOnly.providers.builtin, { modelOverrides: { 'model-a': { cost: { input: 1 } } } });
  removeOverride(overrideOnly, 'builtin', 'model-a');
  assert.deepEqual(overrideOnly.providers, {});

  assert.throws(() => removeProvider(config, 'missing'), /not found/);
  assert.throws(() => removeModel(config, 'p', 'missing'), /not found/);
  assert.throws(() => setModel(config, 'missing', validModel()), /not found/);
});

test('defaults and enabledModels update only their own settings keys', () => {
  const settings: Record<string, unknown> = { theme: 'dark', enabledModels: ['a', 'a', ' b ', ''] };
  setEnabledPatterns(settings, settings.enabledModels as string[]);
  assert.deepEqual(settings.enabledModels, ['a', 'b']);
  setDefaultSelection(settings, { provider: 'p', model: 'm', thinking: 'high' });
  assert.equal(settings.defaultProvider, 'p');
  assert.equal(settings.defaultModel, 'm');
  assert.equal(settings.defaultThinkingLevel, 'high');
  assert.equal(settings.theme, 'dark');
  assert.throws(() => setDefaultSelection(settings, { provider: 'p', model: null }), /both/);
  setDefaultSelection(settings, { provider: null, model: null, thinking: null });
  assert.equal('defaultProvider' in settings, false);
  assert.equal('defaultModel' in settings, false);
  assert.equal('defaultThinkingLevel' in settings, false);
  setEnabledPatterns(settings, []);
  assert.equal('enabledModels' in settings, false);
});

test('settings writes use the same revision check and backup path', async () => {
  const root = await temp();
  const agent = join(root, 'agent');
  await mkdir(agent);
  const backupDir = join(root, 'backups');
  const missing = await readSettings(agent);
  const first = await writeSettings({ defaultProvider: 'p', defaultModel: 'm' }, { agentDir: agent, expectedRevision: missing.revision, backupDir });
  const doc = await readSettings(agent);
  assert.equal(doc.value?.defaultProvider, 'p');
  await writeFile(join(agent, 'settings.json'), '{"theme":"dark"}\n');
  await assert.rejects(writeSettings({}, { agentDir: agent, expectedRevision: first.revision, backupDir }), /changed outside/);
});

test('backup retention keeps the newest files', async () => {
  const root = await temp();
  const agent = join(root, 'agent');
  await mkdir(agent);
  const backupDir = join(root, 'backups');
  let doc = await readModels(agent);
  for (let index = 0; index < 4; index += 1) {
    const result = await writeModels({ providers: { p: validProvider({ name: `v${index}` }) } }, { agentDir: agent, expectedRevision: doc.revision, backupDir, keepBackups: 2 });
    doc = await readModels(agent);
    if (index === 0) assert.equal(result.backup, undefined);
  }
  const files = (await readdir(backupDir)).filter(name => name.endsWith('.bak'));
  assert.equal(files.length, 2);
});

test('secret masking and compact token formatting stay readable', () => {
  assert.equal(maskSecret(undefined), '(none)');
  assert.equal(maskSecret('$OPENAI_API_KEY'), '$OPENAI_API_KEY');
  assert.equal(maskSecret('!jq -r .key'), '!jq -r .key');
  assert.equal(maskSecret('sk-1234567890'), 'sk-1…90');
  assert.equal(maskSecret('short'), '••••');
  assert.equal(formatTokens(128000), '128K');
  assert.equal(formatTokens(16384), '16.4K');
  assert.equal(formatTokens(1050000), '1.05M');
  assert.equal(formatTokens(undefined), 'default');
});
