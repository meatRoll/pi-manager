import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionCommandContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { getKeybindings } from '@earendil-works/pi-tui';
import { checklist } from '../src/pi-ui.js';

const root = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-model-ui-')));
const agent = join(root, 'agent');
await mkdir(agent, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_MANAGER_HOME = join(root, 'manager');
const ui = await import('../src/model-ui.js');
const config = await import('../src/model-config.js');
after(() => rm(root, { recursive: true, force: true }));

type Step =
  | { kind: 'select'; contains?: string; before?: () => Promise<void> }
  | { kind: 'input'; value?: string; before?: () => Promise<void> };

function fakeContext(steps: Step[]) {
  const titles: string[] = [];
  const notes: string[] = [];
  const ctx = {
    mode: 'rpc',
    ui: {
      select: async (title: string, options: string[]) => {
        const step = steps.shift();
        if (!step || step.kind !== 'select') throw new Error(`Expected select: ${title}\nGot: ${JSON.stringify(step)}`);
        titles.push(title);
        if (step.before) await step.before();
        if (step.contains) {
          const found = options.find(option => option.includes(step.contains!));
          if (!found) throw new Error(`No option matching ${step.contains}:\n${options.join('\n')}`);
          return found;
        }
        return options[0];
      },
      input: async (title: string) => {
        const step = steps.shift();
        if (!step || step.kind !== 'input') throw new Error(`Expected input: ${title}\nGot: ${JSON.stringify(step)}`);
        titles.push(title);
        if (step.before) await step.before();
        return step.value;
      },
      editor: async () => undefined,
      confirm: async () => true,
      notify: (message: string, level?: string) => { notes.push(`${level ?? 'info'}: ${message}`); },
      setStatus: () => {},
    },
    modelRegistry: { getModelsOfType: () => [] },
  } as unknown as ExtensionCommandContext;
  return { ctx, steps, titles, notes };
}

function tuiHost() {
  let component: Component | undefined;
  const tui = { requestRender() {} } as unknown as TUI;
  const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  const keys = getKeybindings() as KeybindingsManager;
  const ctx = {
    mode: 'tui',
    ui: {
      custom: <T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component | Promise<Component>) => new Promise<T>(resolve => {
        component = factory(tui, theme, keys, resolve) as Component;
      }),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, component: () => { assert.ok(component); return component; } };
}

test('model rows expose global controls and provider/model entries', async () => {
  const models = await config.readModels();
  const settings = await config.readSettings();
  assert.deepEqual(ui.buildModelRows(models, settings).map(row => row.id), [
    'model:page:providers', 'model:page:models', 'model:defaults', 'model:enabled',
    'model:add-override', 'model:raw',
  ]);
  const pages = ui.buildModelPages(models, settings);
  assert.deepEqual(pages.root.map(row => row.id), ui.buildModelRows(models, settings).map(row => row.id));
  assert.deepEqual(pages.providers.map(row => row.id), ['model:add-provider']);
  assert.deepEqual(pages.models.map(row => row.id), ['model:add-model']);
  assert.match(ui.modelGlobalStatus(models, settings), /0 providers · 0 models · default \(not set\)/);
  assert.match(ui.modelGlobalStatus(models, settings), /\/reload or restart/);
});

test('add provider and model flows edit fields, normalize defaults, and write backups', async () => {
  const provider = fakeContext([
    { kind: 'input', value: 'local' },
    { kind: 'select', contains: 'Name:' },
    { kind: 'input', value: 'Local relay' },
    { kind: 'select', contains: 'Base URL:' },
    { kind: 'input', value: 'https://example.com/v1' },
    { kind: 'select', contains: 'Save changes' },
  ]);
  await ui.addProviderFlow(provider.ctx);
  assert.equal(provider.steps.length, 0);
  assert.ok(provider.titles.some(title => title.includes('Provider local')));
  assert.ok(provider.notes.some(note => note.includes('Provider local saved')));

  const afterProvider = await config.readModels();
  assert.equal(afterProvider.value?.providers?.local.name, 'Local relay');
  assert.equal(afterProvider.value?.providers?.local.baseUrl, 'https://example.com/v1');
  assert.equal(afterProvider.value?.providers?.local.api, 'openai-completions');

  const model = fakeContext([
    { kind: 'input', value: 'fast' },
    { kind: 'select', contains: 'Name:' },
    { kind: 'input', value: 'Fast model' },
    { kind: 'select', contains: 'Context window:' },
    { kind: 'input', value: '200000' },
    { kind: 'select', contains: 'Save changes' },
  ]);
  await ui.addModelFlow(model.ctx, 'local');
  assert.equal(model.steps.length, 0);
  const afterModel = await config.readModels();
  const saved = afterModel.value?.providers?.local.models?.[0];
  assert.deepEqual(saved, {
    id: 'fast', name: 'Fast model', reasoning: false, input: ['text'],
    contextWindow: 200000, maxTokens: 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const settings = await config.readSettings();
  const rows = ui.buildModelRows(afterModel, settings);
  assert.ok(rows.some(row => row.id === 'model:page:providers'));
  assert.ok(rows.some(row => row.id === 'model:page:models'));
  const pages = ui.buildModelPages(afterModel, settings);
  assert.ok(pages.providers.some(row => row.id === 'model:provider:local' && row.editable));
  assert.ok(pages.models.some(row => row.id === 'model:entry:local/fast' && row.editable));
});

test('defaults and enabled models flows write settings without touching models.json', async () => {
  const defaults = fakeContext([
    { kind: 'select', contains: 'Pick from configured models' },
    { kind: 'select', contains: 'local/fast' },
    { kind: 'select', contains: 'Default thinking level:' },
    { kind: 'select', contains: 'high' },
    { kind: 'select', contains: 'Save changes' },
  ]);
  await ui.defaultsFlow(defaults.ctx);
  assert.equal(defaults.steps.length, 0);
  assert.deepEqual(JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')), {
    defaultProvider: 'local', defaultModel: 'fast', defaultThinkingLevel: 'high',
  });

  const before = await readFile(join(agent, 'models.json'), 'utf8');
  const enabled = fakeContext([
    { kind: 'select', contains: '+ Add pattern' },
    { kind: 'input', value: 'local/*' },
    { kind: 'select', contains: 'Save changes' },
  ]);
  await ui.enabledFlow(enabled.ctx);
  assert.equal(enabled.steps.length, 0);
  assert.deepEqual(JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')), {
    defaultProvider: 'local', defaultModel: 'fast', defaultThinkingLevel: 'high', enabledModels: ['local/*'],
  });
  assert.equal(await readFile(join(agent, 'models.json'), 'utf8'), before);
  assert.ok(enabled.notes.some(note => note.includes('/model still lists every available model')));
});

test('a save conflict is shown and never overwrites the external file', async () => {
  const flow = fakeContext([
    {
      kind: 'input', value: 'other',
      before: async () => writeFile(join(agent, 'models.json'), '{"providers":{}}\n'),
    },
    { kind: 'select', contains: 'Name:' },
    { kind: 'input', value: 'Other' },
    { kind: 'select', contains: 'Base URL:' },
    { kind: 'input', value: 'https://example.com/v1' },
    { kind: 'select', contains: 'Save changes' },
    { kind: 'select', contains: 'Back' },
    { kind: 'select', contains: 'Cancel' },
  ]);
  await ui.addProviderFlow(flow.ctx);
  assert.equal(flow.steps.length, 0);
  assert.ok(flow.titles.some(title => title.includes('changed outside pi-manager')));
  assert.deepEqual(JSON.parse(await readFile(join(agent, 'models.json'), 'utf8')), { providers: {} });
});

test('checklist starts empty, A selects every new model, and disabled rows stay disabled', async () => {
  const host = tuiHost();
  const result = checklist(host.ctx, 'Add models', [
    { label: 'alpha', value: 'alpha' },
    { label: 'beta', value: 'beta' },
    { label: 'configured', value: 'configured', disabled: true },
  ]);
  const component = host.component();
  assert.ok(component.render(80).some(line => line.includes('[ ] alpha')));
  assert.equal(component.render(80).some(line => line.includes('[x] alpha')), false);
  component.handleInput!('A');
  assert.ok(component.render(80).some(line => line.includes('[x] alpha')));
  assert.ok(component.render(80).some(line => line.includes('configured')));
  component.handleInput!('N');
  assert.equal(component.render(80).some(line => line.includes('[x] alpha')), false);
  component.handleInput!('A');
  component.handleInput!('\r');
  assert.deepEqual(await result, ['alpha', 'beta']);

  const rpc = fakeContext([
    { kind: 'select', contains: 'Choose by number' },
    { kind: 'select', contains: 'Back' },
    { kind: 'input', value: '' },
  ]);
  assert.deepEqual(await checklist(rpc.ctx, 'Add models', [
    { label: 'alpha', value: 'alpha' },
    { label: 'beta', value: 'beta' },
  ]), []);
  const all = fakeContext([{ kind: 'select', contains: 'Add all new' }]);
  assert.deepEqual(await checklist(all.ctx, 'Add models', [
    { label: 'alpha', value: 'alpha' },
    { label: 'beta', value: 'beta' },
  ]), ['alpha', 'beta']);
});
