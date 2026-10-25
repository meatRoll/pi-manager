import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionCommandContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, Focusable, TUI } from '@earendil-works/pi-tui';
import { getKeybindings, visibleWidth } from '@earendil-works/pi-tui';
import { dashboard, newDashboardState } from '../src/dashboard.js';
import type { DashboardModel } from '../src/dashboard.js';

function host() {
  let component: (Component & Partial<Focusable>) | undefined;
  const tui = { requestRender() {} } as unknown as TUI;
  const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  const keys = getKeybindings() as KeybindingsManager;
  const custom = <T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component | Promise<Component>): Promise<T> => new Promise(resolve => {
    component = factory(tui, theme, keys, resolve) as Component;
  });
  const ctx = { mode: 'tui', ui: { custom } } as unknown as ExtensionCommandContext;
  return { ctx, component: () => { assert.ok(component); return component; } };
}
const fixture = (): DashboardModel => {
  const extensions = [
    { id: 'resource:a', label: '[x] alpha · src/index.ts', detail: 'extensions · package · read-only', toggle: true },
    { id: 'resource:b', label: '[x] 中文 beta · index.ts', detail: 'extensions · standalone · owned', toggle: true, editable: true, deletable: true },
  ];
  return {
    profile: 'mine', loading: 'loaded: mine · next start: mine', publication: 'Unpublished changes · P publish for next start', pending: true,
    rows: { all: extensions, extensions, skills: [{ id: 'resource:skill', label: '[x] skill', toggle: true }], context: [], packages: [{ id: 'package:npm:alpha', label: '[x] alpha', toggle: true }], more: [{ id: 'versions', label: 'Package generations / restore' }], prompts: [], themes: [] },
  };
};

test('dashboard starts flat, changes category in place, preserves each selection and fits narrow/wide terminals', async () => {
  const h = host(), state = newDashboardState();
  const result = dashboard(h.ctx, fixture(), state);
  const component = h.component(); component.focused = true;
  assert.ok(component.render(100).some(line => line.includes('alpha · src/index.ts')));
  component.handleInput!('\x1b[B'); // second row in All
  component.handleInput!('\x1b[C'); // Extensions
  assert.equal(state.tab, 'extensions');
  component.handleInput!('\x1b[D'); // All restores its second row
  assert.equal(state.views.all?.selected, 'resource:b');
  for (const width of [1, 8, 20, 42, 80, 120]) {
    const lines = component.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
  component.invalidate();
  component.handleInput!(' ');
  assert.deepEqual(await result, { kind: 'toggle', id: 'resource:b' });
  const reopened = dashboard(h.ctx, fixture(), state);
  h.component().handleInput!('\r');
  assert.deepEqual(await reopened, { kind: 'open', id: 'resource:b' });
});

test('dashboard search keeps shortcuts literal while typing, preserves focus and survives actions', async () => {
  const h = host(), state = newDashboardState();
  const result = dashboard(h.ctx, fixture(), state);
  const component = h.component(); component.focused = true;
  component.handleInput!('/'); component.handleInput!('beta');
  assert.ok(component.render(80).some(line => line.includes('中文 beta')));
  assert.equal(component.render(80).some(line => line.includes('alpha ·')), false);
  assert.equal(state.views.all?.query, 'beta');
  component.handleInput!('\r'); // only exit search, no preview
  component.handleInput!('e');
  assert.deepEqual(await result, { kind: 'edit', id: 'resource:b' });
  const reopened = dashboard(h.ctx, fixture(), state);
  assert.equal(state.views.all?.query, 'beta');
  h.component().handleInput!('\x1b'); // clears filter before closing
  assert.ok(h.component().render(100).some(line => line.includes('alpha ·')));
  h.component().handleInput!('\x1b');
  assert.equal(await reopened, undefined);
});

test('dashboard shortcuts do not mutate read-only rows and emit actions only once', async () => {
  const h = host();
  const readonly = dashboard(h.ctx, fixture(), newDashboardState());
  h.component().handleInput!('e'); h.component().handleInput!('\x1b[3~');
  h.component().handleInput!('\r'); h.component().handleInput!('p');
  assert.deepEqual(await readonly, { kind: 'open', id: 'resource:a' });
  for (const [key, kind] of [['a', 'add'], ['p', 'publish'], ['s', 'switch'], ['r', 'refresh']] as const) {
    const result = dashboard(h.ctx, fixture(), newDashboardState());
    h.component().handleInput!(key); assert.deepEqual(await result, { kind });
  }
  const state = newDashboardState(); state.tab = 'packages';
  const toggle = dashboard(h.ctx, fixture(), state); h.component().handleInput!(' ');
  assert.deepEqual(await toggle, { kind: 'toggle', id: 'package:npm:alpha' });
  state.tab = 'all'; state.views.all = { query: '', selected: 'resource:b' };
  const remove = dashboard(h.ctx, fixture(), state); h.component().handleInput!('\x1b[3~');
  assert.deepEqual(await remove, { kind: 'delete', id: 'resource:b' });
});

test('dashboard tabs, paging, empty and sanitised rows stay usable after resize', async () => {
  const h = host(), state = newDashboardState(), model = fixture();
  model.rows.all = Array.from({ length: 30 }, (_, index) => ({ id: `resource:${index}`, label: `[x] ${index} \x1b[2Jresource\nname`, toggle: true }));
  const result = dashboard(h.ctx, model, state);
  const component = h.component();
  assert.ok(component.render(90).every(line => !line.includes('\x1b[2J')));
  component.handleInput!('\x1b[6~'); assert.notEqual(state.views.all?.selected, 'resource:0');
  component.handleInput!('\x1b[5~'); assert.equal(state.views.all?.selected, 'resource:0');
  component.handleInput!('\t'); component.handleInput!('\t'); component.handleInput!('\t');
  assert.equal(state.tab, 'context');
  assert.ok(component.render(90).some(line => line.includes('No entries')));
  component.handleInput!(' '); // empty tab has no toggle target
  component.handleInput!('\x1b[Z'); assert.equal(state.tab, 'skills');
  component.handleInput!('\x1b'); assert.equal(await result, undefined);
});

test('dashboard respects injected selection keybindings, preserves cursor focus and leaves footer room', async () => {
  const h = host(), keys = getKeybindings(), original = keys.getUserBindings();
  try {
    keys.setUserBindings({ ...original, 'tui.select.down': 'ctrl+n', 'tui.select.confirm': 'ctrl+y', 'tui.select.cancel': 'ctrl+x' });
    const result = dashboard(h.ctx, fixture(), newDashboardState());
    const component = h.component(); component.focused = true;
    component.handleInput!('\x0e'); // ctrl+n selects second row
    component.handleInput!('/'); component.handleInput!('beta');
    assert.ok(component.render(42).join('\n').includes('beta'));
    assert.equal(component.focused, true);
    component.handleInput!('\x19'); // ctrl+y exits search only
    component.handleInput!('\x19'); // then opens selected item
    assert.deepEqual(await result, { kind: 'open', id: 'resource:b' });
  } finally { keys.setUserBindings(original); }
  const state = newDashboardState(); state.tab = 'more'; const model = fixture();
  model.rows.more = Array.from({ length: 15 }, (_, index) => ({ id: `more:${index}`, label: `Action ${index}` }));
  const result = dashboard(h.ctx, model, state);
  assert.ok(h.component().render(42).length <= 19); // 24 rows minus Pi chrome
  assert.ok(h.component().render(42).some(line => line.includes('Esc')));
  h.component().handleInput!('\x1b'); await result;
});

test('native dashboard renders before deferred discovery and keeps navigation/search while rows arrive', async () => {
  const h = host(), state = newDashboardState(), ready = fixture();
  const shell = { ...ready, busy: true, publication: 'Checking publication in background…', rows: { ...ready.rows, all: [], extensions: [] } };
  let deliver: ((model: DashboardModel) => void) | undefined;
  const result = dashboard(h.ctx, shell, state, async (update, signal) => {
    deliver = update;
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  const component = h.component(); component.focused = true;
  assert.ok(component.render(100).some(line => line.includes('Reading resource metadata')));
  component.handleInput!('p'); component.handleInput!('a'); // no writes before discovery
  component.handleInput!('\t'); component.handleInput!('/'); component.handleInput!('beta');
  await Promise.resolve(); assert.ok(deliver);
  deliver({ ...ready, busy: false });
  assert.equal(state.tab, 'extensions'); assert.equal(state.views.extensions?.query, 'beta');
  assert.ok(component.render(100).some(line => line.includes('中文 beta')));
  component.handleInput!('\r'); component.handleInput!(' ');
  assert.deepEqual(await result, { kind: 'toggle', id: 'resource:b' });
  const selectedBefore = state.views.extensions?.selected;
  deliver({ ...shell, rows: shell.rows }); // stale update after close is ignored
  assert.equal(state.views.extensions?.selected, selectedBefore);
});

test('dashboard cancellation aborts background work; discovery failures stay retryable without unsafe actions', async () => {
  const h = host(); let signal: AbortSignal | undefined, aborted = false;
  const result = dashboard(h.ctx, fixture(), newDashboardState(), async (_update, currentSignal) => {
    signal = currentSignal;
    await new Promise<void>(resolve => currentSignal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
  });
  await Promise.resolve(); h.component().handleInput!('\x1b');
  assert.equal(await result, undefined); assert.equal(signal?.aborted, true); assert.equal(aborted, true);
  const failed = dashboard(h.ctx, { ...fixture(), busy: true }, newDashboardState(), async () => { throw new Error('fixture discovery failed'); });
  for (let count = 0; count < 6; count++) await Promise.resolve();
  const component = h.component(); component.handleInput!('a'); component.handleInput!('p');
  // Existing fixture rows are still displayable, but mutation shortcuts are blocked.
  component.handleInput!('r'); assert.deepEqual(await failed, { kind: 'refresh' });
});

test('RPC background checks never open overlapping dialogs or delay first complete resource list', async () => {
  let respond: ((value: string | undefined) => void) | undefined, checking = false;
  const ctx = { mode: 'rpc', ui: { select: async () => new Promise<string | undefined>(resolve => { respond = resolve; }) } } as unknown as ExtensionCommandContext;
  const result = dashboard(ctx, fixture(), newDashboardState(), async (_update, signal) => {
    checking = true;
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  assert.ok(respond); // displayed before background finishes
  await Promise.resolve(); assert.equal(checking, true);
  respond(undefined); assert.equal(await result, undefined);
});

test('RPC dashboard navigates tabs without a profile submenu and returns stable IDs', async () => {
  const selections = ['Tab: Extensions', '中文 beta'];
  const titles: string[] = [];
  const ctx = { mode: 'rpc', ui: { select: async (title: string, options: string[]) => {
    titles.push(title); const text = selections.shift(); return options.find(option => text && option.includes(text));
  } } } as unknown as ExtensionCommandContext;
  const state = newDashboardState();
  assert.deepEqual(await dashboard(ctx, fixture(), state), { kind: 'open', id: 'resource:b' });
  assert.ok(titles[0].startsWith('pi-manager / mine / All'));
  assert.ok(titles[1].startsWith('pi-manager / mine / Extensions'));
  assert.equal(state.tab, 'extensions');
});
