import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, rm, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand, BeforeAgentStartEvent, NormalizedBuildSystemPromptOptions } from '@earendil-works/pi-coding-agent';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-extension-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
const { default: extension } = await import('../src/extension.js');
const core = await import('../src/core.js');
const { inventory } = await import('../src/resources.js');
const { BUNDLE_DIR, publishedBundle } = await import('../src/bundle.js');
const { initialProfile } = await import('../src/pi-manager.js');
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
  const dialogs: { title: string; options: string[] }[] = [];
  const ctx = {
    cwd: temp, hasUI: true, mode: 'rpc', isIdle: () => true,
    ui: {
      notify(message: string) { notes.push(message); },
      setStatus() {},
      async select(title: string, options: string[]) {
        titles.push(title); dialogs.push({ title, options });
        const next = selections.shift(); if (!next) return undefined;
        const result = options.find(item => item.includes(next)); assert.ok(result, `${next}: ${options.join(', ')}`); return result;
      },
      async input() { return inputs.shift(); },
      async editor() { return editors.shift(); },
      async confirm() { return true; },
    },
  } as unknown as ExtensionCommandContext;
  return { pi, ctx, notes, selections, inputs, editors, titles, dialogs, handlers, run: async () => { assert.ok(command); await command.handler('', ctx); } };
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

test('empty preset picker retains help and manager-only publication without requiring a dummy preset', async () => {
  const h = harness(); extension(h.pi); h.selections.push('About / loading instructions'); await h.run();
  assert.ok(h.dialogs[0].options.some(option => option.includes('Use manager only on next Pi start')));
  assert.ok(h.titles.some(title => title.startsWith('About pi-manager')));
  assert.deepEqual(await core.listProfiles(), []);
});

test('/manager creates a staging profile through native Pi dialogs and returns to the same host', async () => {
  const h = harness(); extension(h.pi);
  h.selections.push('+ Create profile'); h.inputs.push('review');
  await h.run();
  assert.equal((await core.listProfiles())[0].name, 'review');
  assert.ok(h.titles[0].includes('pi-manager'));
  assert.ok(h.notes.every(note => note === 'Reading staging metadata…'));
  assert.ok(h.titles.some(title => title.startsWith('pi-manager / review / All')));
});

test('Pi editor context and publish are usable in the same session; native/global files are not copied', async () => {
  const h = harness(); extension(h.pi);
  h.selections.push('Tab: Context', '+ Add resource', '+ Create context');
  h.inputs.push('rules'); h.editors.push('Keep this context private to the managed preset.');
  await h.run();
  assert.equal((await core.getMetadata('review')).contexts[0].name, 'rules');
  const next = harness(); extension(next.pi);
  next.selections.push('Publish for next Pi start'); await next.run();
  assert.equal((await publishedBundle())?.profile, 'review');
  const manifest = JSON.parse(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'));
  assert.equal(manifest.piManager.contexts[0].content, 'Keep this context private to the managed preset.');
  assert.match(next.notes.join('\n'), /Restart Pi/);
});

test('/manager explicitly confirms package import and reports external references and unchanged source settings', async () => {
  const source = join(temp, 'source-agent'); const local = join(source, 'local-package');
  await mkdir(local, { recursive: true });
  await writeFile(join(local, 'package.json'), JSON.stringify({ name: 'import-fixture', pi: { extensions: ['./index.js'] } }));
  await writeFile(join(local, 'index.js'), 'export default function() {}');
  const sourceText = JSON.stringify({ packages: ['./local-package', BUNDLE_DIR] });
  await writeFile(join(source, 'settings.json'), sourceText);
  await core.createProfile('imported');
  const before = process.env.PI_MANAGER_SOURCE_AGENT_DIR;
  try {
    process.env.PI_MANAGER_SOURCE_AGENT_DIR = source;
    const declined = harness(); extension(declined.pi);
    declined.ctx.ui.confirm = async (_title, message) => { assert.match(message, /Read-only source/); return false; };
    declined.selections.push('Switch preset', 'imported', 'Tab: More', 'Import packages from current Pi'); await declined.run();
    assert.deepEqual((await core.getSettings('imported')).packages, []);
    const accepted = harness(); extension(accepted.pi);
    accepted.selections.push('Switch preset', 'imported', 'Tab: More', 'Import packages from current Pi'); await accepted.run();
    assert.deepEqual((await core.getSettings('imported')).packages, [local]);
    assert.match(accepted.notes.join('\n'), /Imported 1 packages/);
    assert.match(accepted.notes.join('\n'), /Source settings unchanged/);
    assert.equal(await readFile(join(source, 'settings.json'), 'utf8'), sourceText);
    assert.equal((await publishedBundle())?.profile, 'review'); // import does not publish
  } finally {
    if (before === undefined) delete process.env.PI_MANAGER_SOURCE_AGENT_DIR;
    else process.env.PI_MANAGER_SOURCE_AGENT_DIR = before;
  }
});

test('/manager shows package-qualified extension labels and keeps selection bound to resource IDs', async () => {
  await core.createProfile('display');
  const packages = [join(temp, 'display-first'), join(temp, 'display-second')];
  for (const [index, source] of packages.entries()) {
    await mkdir(source);
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: index ? '@scope/second-label' : 'first-label', pi: { extensions: ['./index.js'] } }));
    await writeFile(join(source, 'index.js'), 'throw new Error("MUST NOT EXECUTE FOR DISPLAY");');
  }
  const settings = await core.getSettings('display'); settings.packages = packages;
  await core.saveSettings('display', settings);
  const h = harness(); extension(h.pi);
  h.selections.push('Switch preset', 'display', 'Tab: Extensions', '@scope/second-label · index.js', 'Disable');
  await h.run();
  const list = h.dialogs.find(dialog => dialog.title.includes('display / Extensions'));
  assert.ok(list);
  assert.ok(list.options.some(label => label.includes('[x] first-label · index.js')));
  assert.ok(list.options.some(label => label.includes('[x] @scope/second-label · index.js')));
  assert.ok(h.titles.some(title => title.includes('@scope/second-label · index.js · external / package read-only')));
  const state = await inventory('display');
  assert.equal(state.resources.find(resource => resource.source === packages[0])?.enabled, true);
  assert.equal(state.resources.find(resource => resource.source === packages[1])?.enabled, false);
  assert.deepEqual((await core.getSettings('display')).packages, [packages[0], { source: packages[1], extensions: ['-index.js'] }]);
  const details = harness(); extension(details.pi);
  details.selections.push('Switch preset', 'display', 'Tab: Packages', 'first-label', 'extensions: first-label · index.js', 'Preview');
  await details.run();
  assert.ok(details.titles.some(title => title.startsWith('first-label · index.js\n') && title.includes('MUST NOT EXECUTE FOR DISPLAY')));
  assert.equal((await publishedBundle())?.profile, 'review');
});

test('/manager uses configured Git repo labels in extensions, package lists and titles, retaining raw manifest metadata', async () => {
  await core.createProfile('fork-display');
  const source = 'git:github.com/meatRoll/pi-image-gen';
  const root = join(core.profilePath('fork-display'), 'git/github.com/meatRoll/pi-image-gen');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@ssweens/pi-image-gen', pi: { extensions: ['./index.js'] } }));
  await writeFile(join(root, 'index.js'), 'throw new Error("label inventory must not execute extensions");');
  const settings = await core.getSettings('fork-display'); settings.packages = [source]; await core.saveSettings('fork-display', settings);
  const before = await readFile(join(core.profilePath('fork-display'), 'settings.json'), 'utf8');
  const h = harness(); extension(h.pi);
  h.selections.push('Switch preset', 'fork-display', 'Tab: Packages', '[x] meatRoll/pi-image-gen', 'Package details'); await h.run();
  assert.ok(h.dialogs.some(dialog => dialog.options.some(label => label.includes('[x] meatRoll/pi-image-gen · index.js'))));
  assert.ok(h.titles.some(title => title.startsWith('meatRoll/pi-image-gen · local')));
  assert.ok(h.titles.some(title => title.startsWith('Package details') && title.includes('@ssweens/pi-image-gen') && title.includes(source)));
  assert.equal(await readFile(join(core.profilePath('fork-display'), 'settings.json'), 'utf8'), before);
});

test('manager starts directly in the default preset; fallback selection never adopts a deleted preset', async () => {
  const profiles = await core.listProfiles();
  assert.equal(initialProfile(profiles, 'display', 'review', 'imported'), 'display');
  assert.equal(initialProfile(profiles, 'deleted', 'review', 'imported'), 'review');
  assert.equal(initialProfile(profiles, 'deleted', 'also-deleted', 'imported'), 'imported');
  assert.equal(initialProfile([], 'deleted', 'review', 'imported'), undefined);
  await core.setDefaultProfile('display');
  const settingsBefore = await readFile(join(core.profilePath('display'), 'settings.json'), 'utf8');
  const bundleBefore = await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8');
  const h = harness(); extension(h.pi); await h.run();
  assert.ok(h.titles[0].startsWith('pi-manager / display / All'));
  assert.ok(h.dialogs[0].options.some(label => label.includes('first-label · index.js')));
  assert.equal(await readFile(join(core.profilePath('display'), 'settings.json'), 'utf8'), settingsBefore);
  assert.equal(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'), bundleBefore);
});

test('a broken default staging preset offers a safe switch instead of making the manager unreachable', async () => {
  await core.createProfile('broken'); await core.setDefaultProfile('broken');
  const settingsPath = join(core.profilePath('broken'), 'settings.json');
  await writeFile(settingsPath, 'not valid JSON');
  const h = harness(); extension(h.pi);
  h.selections.push('Switch preset', 'display'); await h.run();
  assert.match(h.titles[0], /Cannot read staging preset: broken/);
  assert.ok(h.titles.some(title => title.startsWith('pi-manager / display / All')));
  assert.equal(await readFile(settingsPath, 'utf8'), 'not valid JSON');
  await core.setDefaultProfile('display');
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
