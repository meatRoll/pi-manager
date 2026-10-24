import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand, BeforeAgentStartEvent, NormalizedBuildSystemPromptOptions } from '@earendil-works/pi-coding-agent';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-extension-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
const { default: extension } = await import('../src/extension.js');
const core = await import('../src/core.js');
const { BUNDLE_DIR, publishedBundle } = await import('../src/bundle.js');
after(() => rm(temp, { recursive: true, force: true }));

function harness() {
  let command: RegisteredCommand | undefined;
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  // Deliberately minimal host: unexpected API calls fail rather than silently
  // allowing the extension to start processes, reload, or mutate the runtime.
  const pi = {
    registerCommand(name: string, value: RegisteredCommand) { assert.equal(name, 'manager'); command = value; },
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); return () => {}; },
  } as unknown as ExtensionAPI;
  const notes: string[] = [], selections: string[] = [], inputs: string[] = [], editors: string[] = [], titles: string[] = [];
  const ctx = {
    cwd: temp, hasUI: true, mode: 'rpc', isIdle: () => true,
    ui: {
      notify(message: string) { notes.push(message); },
      setStatus() {},
      async select(title: string, options: string[]) {
        titles.push(title);
        const next = selections.shift(); if (!next) return undefined;
        const result = options.find(item => item.includes(next)); assert.ok(result, `${next}: ${options.join(', ')}`); return result;
      },
      async input() { return inputs.shift(); },
      async editor() { return editors.shift(); },
      async confirm() { return true; },
    },
  } as unknown as ExtensionCommandContext;
  return { pi, ctx, notes, selections, inputs, editors, titles, handlers, run: async () => { assert.ok(command); await command.handler('', ctx); } };
}

test('extension factory only registers command/events and non-UI/busy modes do not write manager files', async () => {
  const h = harness(); extension(h.pi);
  assert.deepEqual(await readdir(temp), []);
  h.ctx.mode = 'print'; h.ctx.hasUI = false; await h.run();
  assert.match(h.notes.pop()!, /requires Pi interactive UI/);
  h.ctx.mode = 'rpc'; h.ctx.hasUI = true; h.ctx.isIdle = () => false; await h.run();
  assert.match(h.notes.pop()!, /Wait for/);
  assert.deepEqual(await readdir(temp), []);
});

test('/manager creates a staging profile through native Pi dialogs and returns to the same host', async () => {
  const h = harness(); extension(h.pi);
  h.selections.push('+ Create profile'); h.inputs.push('review');
  await h.run();
  assert.equal((await core.listProfiles())[0].name, 'review');
  assert.ok(h.titles[0].includes('pi-manager'));
  assert.equal(h.notes.length, 0);
});

test('Pi editor context and publish are usable in the same session; native/global files are not copied', async () => {
  const h = harness(); extension(h.pi);
  h.selections.push('review', 'Context files', '+ Create context');
  h.inputs.push('rules'); h.editors.push('Keep this context private to the managed preset.');
  await h.run();
  assert.equal((await core.getMetadata('review')).contexts[0].name, 'rules');
  const next = harness(); extension(next.pi);
  next.selections.push('review', 'Use on next Pi start'); await next.run();
  assert.equal((await publishedBundle())?.profile, 'review');
  const manifest = JSON.parse(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'));
  assert.equal(manifest.piManager.contexts[0].content, 'Keep this context private to the managed preset.');
  assert.match(next.notes.join('\n'), /Restart Pi/);
});

test('context hook uses only its startup-bound snapshot and preserves unrelated prompt sections', async () => {
  const h = harness();
  const loaded = { format: 1 as const, id: 'snapshot-one', profile: 'review', managerHome: core.MANAGER_HOME, contexts: [{ name: 'rules', content: 'Original startup context' }] };
  extension(h.pi, loaded);
  const options: NormalizedBuildSystemPromptOptions = { cwd: temp, sections: { existing: 'untouched' }, selectedTools: [], hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: '', contextFiles: [], skills: [] };
  const event = { systemPromptOptions: options } as BeforeAgentStartEvent;
  const handler = h.handlers.get('before_agent_start'); assert.ok(handler); await handler(event, h.ctx);
  assert.equal(event.systemPromptOptions.sections.existing, 'untouched');
  assert.match(event.systemPromptOptions.sections.pi_manager_context, /Original startup context/);
  assert.ok(!event.systemPromptOptions.sections.pi_manager_context.includes('Keep this context'));
});

test('duplicate manager commands and manager-home mismatch are rejected', async () => {
  const h = harness(); extension(h.pi);
  let unblock: (value: undefined) => void = () => {};
  let ready: () => void = () => {};
  const opened = new Promise<void>(resolve => { ready = resolve; });
  h.ctx.ui.select = () => new Promise<undefined>(resolve => { unblock = resolve; ready(); });
  const pending = h.run();
  await opened;
  await h.run(); assert.match(h.notes.pop()!, /already open/); unblock(undefined); await pending;
  const bad = harness(); extension(bad.pi, { format: 1, id: 'other', profile: null, managerHome: '/wrong/home', contexts: [] });
  await bad.run(); assert.match(bad.notes.pop()!, /differs/);
});
