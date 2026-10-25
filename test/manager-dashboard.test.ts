import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExtensionCommandContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, Focusable, TUI } from '@earendil-works/pi-tui';
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-panel-flow-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
const core = await import('../src/core.js');
const { openManager } = await import('../src/pi-manager.js');
const { inventory, importResource } = await import('../src/resources.js');
const { BUNDLE_DIR, publishBundle } = await import('../src/bundle.js');
after(() => rm(temp, { recursive: true, force: true }));

function host() {
  let active: (Component & Partial<Focusable>) | undefined;
  const components: (Component & Partial<Focusable>)[] = [], notes: string[] = [], confirms: string[] = [], editorTitles: string[] = [];
  const editorValues: (string | undefined)[] = [];
  let accept = false;
  const ctx = {
    mode: 'tui', cwd: temp,
    ui: {
      notify(message: string) { notes.push(message); }, setStatus() {},
      confirm: async (title: string) => { confirms.push(title); return accept; },
      editor: async (title: string) => { editorTitles.push(title); return editorValues.shift(); },
      custom: <T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component): Promise<T> => new Promise(resolve => {
        active = factory({ requestRender() {} } as TUI, { fg: (_color: string, text: string) => text } as Theme, getKeybindings() as KeybindingsManager, resolve);
        active.focused = true; components.push(active);
      }),
    },
  } as unknown as ExtensionCommandContext;
  const wait = async (text: string, after = 0) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const found = components.slice(after).find(component => component.render(120).some(line => line.includes(text)));
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Component not shown: ${text}; notes: ${notes.join(', ')}`);
  };
  return { ctx, notes, components, confirms, editorValues, editorTitles, accept: () => { accept = true; }, wait };
}

// This end-to-end flow starts many real SDK workers. Allow for the full test
// runner's parallel CPU contention; each individual UI wait is still bounded.
test('native /manager opens default flat, toggles by Space, previews by Enter, edits by E and publishes only after confirmation', { timeout: 120000 }, async () => {
  await core.createProfile('mine');
  const extension = join(temp, 'handoff.ts'); await writeFile(extension, 'export default function () {}');
  const owned = await importResource('mine', 'extensions', extension);
  const first = await publishBundle('mine');
  const manifestPath = join(BUNDLE_DIR, 'package.json');
  const manifestBefore = await readFile(manifestPath, 'utf8');
  const h = host(); const running = openManager(h.ctx, first);
  const shell = await h.wait('Reading resource metadata');
  assert.equal(shell.render(120).some(line => line.includes('[x] handoff.ts')), false);
  assert.ok(shell.render(120).some(line => line.includes('Checking publication')));
  let panel = await h.wait('Published ·');
  assert.equal(h.components.length, 1); // rows/status arrive in the same screen
  assert.ok(panel.render(120).some(line => line.includes('[x] handoff.ts')));
  assert.ok(panel.render(120).some(line => line.includes('Published ·')));
  let index = h.components.length;
  panel.handleInput!(' ');
  panel = await h.wait('Unpublished changes', index);
  assert.ok(panel.render(120).some(line => line.includes('[ ] handoff.ts')));
  assert.equal((await inventory('mine')).resources[0].enabled, false);
  assert.equal(await readFile(manifestPath, 'utf8'), manifestBefore);
  index = h.components.length;
  panel.handleInput!('\r'); // direct preview, not an actions menu
  const preview = await h.wait('pi-manager / handoff.ts', index);
  assert.ok(preview.render(120).some(line => line.includes('export default')));
  index = h.components.length; preview.handleInput!('\x1b');
  panel = await h.wait('pi-manager / mine', index);
  h.editorValues.push('export default function () { /* edited copy */ }');
  index = h.components.length; panel.handleInput!('e');
  panel = await h.wait('[ ] handoff.ts', index);
  assert.deepEqual(h.editorTitles, ['handoff.ts']); assert.match(await readFile(owned, 'utf8'), /edited copy/);
  assert.equal(await readFile(extension, 'utf8'), 'export default function () {}');
  index = h.components.length; panel.handleInput!('p'); // decline
  panel = await h.wait('pi-manager / mine', index);
  assert.equal(await readFile(manifestPath, 'utf8'), manifestBefore); assert.deepEqual(h.confirms, ['Use on next Pi start?']);
  // Restore enabled state and publish, keeping the live snapshot intact.
  index = h.components.length; panel.handleInput!(' '); panel = await h.wait('[x] handoff.ts', index);
  index = h.components.length; panel.handleInput!('\x1b[3~'); panel = await h.wait('[x] handoff.ts', index); // declined deletion
  assert.ok(h.confirms.includes('Delete owned copy?'));
  assert.match(await readFile(owned, 'utf8'), /edited copy/);
  h.accept(); index = h.components.length; panel.handleInput!('p'); panel = await h.wait('Published · restart Pi', index);
  const manifestAfter = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.notEqual(manifestAfter.piManager.id, first.id);
  assert.equal(await readFile(join(BUNDLE_DIR, '.snapshots', first.id, 'resources/extensions/handoff.ts'), 'utf8'), 'export default function () {}');
  assert.match(h.notes.join('\n'), /current extensions|Restart Pi/);
  panel.handleInput!('\x1b'); await running;
});

test('native /manager can close during first discovery without a worker or config mutation surviving it', async () => {
  await core.setDefaultProfile('mine');
  const settingsPath = join(core.profilePath('mine'), 'settings.json');
  const before = await readFile(settingsPath, 'utf8');
  const bundle = await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8');
  const h = host(); const running = openManager(h.ctx);
  const shell = await h.wait('Reading resource metadata');
  shell.handleInput!('\x1b'); await running;
  const count = h.components.length;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.components.length, count);
  assert.equal(await readFile(settingsPath, 'utf8'), before);
  assert.equal(await readFile(join(BUNDLE_DIR, 'package.json'), 'utf8'), bundle);
  assert.equal(h.notes.length, 0);
});

test('native panel labels local Git packages by origin and keeps read-only rows and saved filters', { timeout: 60000 }, async () => {
  await core.createProfile('package-panel'); await core.setDefaultProfile('package-panel');
  const source = join(temp, 'package'); await mkdir(source);
  execFileSync('git', ['-C', source, 'init'], { stdio: 'pipe' });
  execFileSync('git', ['-C', source, 'config', '--local', 'remote.origin.url', 'https://github.com/meatRoll/pi-todos.git'], { stdio: 'pipe' });
  const configBefore = await readFile(join(source, '.git/config'), 'utf8');
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'same-index', pi: { extensions: ['./index.js'] } }));
  await writeFile(join(source, 'index.js'), 'throw new Error("must not execute for panel");');
  const settings = await core.getSettings('package-panel'); settings.packages = [{ source, skills: [], extensions: ['+index.js'] }];
  await core.saveSettings('package-panel', settings);
  const h = host(); const running = openManager(h.ctx);
  let panel = await h.wait('meatRoll/pi-todos · index.js');
  assert.ok(panel.render(120).some(line => line.includes('[x] meatRoll/pi-todos · index.js')));
  const before = await readFile(join(core.profilePath('package-panel'), 'settings.json'), 'utf8');
  panel.handleInput!('e'); panel.handleInput!('\x1b[3~');
  assert.equal(h.components.length, 1); assert.equal(h.confirms.length, 0); assert.equal(h.editorTitles.length, 0);
  for (let index = 0; index < 4; index++) panel.handleInput!('\t');
  assert.ok(panel.render(120).some(line => line.includes('[Packages]')));
  let count = h.components.length; panel.handleInput!(' '); panel = await h.wait('[ ] meatRoll/pi-todos', count);
  assert.ok(panel.render(120).some(line => line.includes('[ ] meatRoll/pi-todos')));
  assert.equal((await inventory('package-panel')).packages[0].enabled, false);
  count = h.components.length; panel.handleInput!(' '); panel = await h.wait('[x] meatRoll/pi-todos', count);
  assert.equal((await inventory('package-panel')).packages[0].enabled, true);
  assert.deepEqual((await core.getSettings('package-panel')).packages, settings.packages);
  for (const width of [18, 38, 80, 120]) for (const line of panel.render(width)) assert.ok(visibleWidth(line) <= width);
  assert.equal(await readFile(join(core.profilePath('package-panel'), 'settings.json'), 'utf8'), before);
  assert.equal(await readFile(join(source, '.git/config'), 'utf8'), configBefore);
  panel.handleInput!('\x1b'); await running;
});
