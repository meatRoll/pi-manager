import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionCommandContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, Focusable, TUI } from '@earendil-works/pi-tui';
import { visibleWidth } from '@earendil-works/pi-tui';
import { choose, view } from '../src/pi-ui.js';

function host() {
  let component: (Component & Partial<Focusable>) | undefined;
  const tui = { requestRender() {} } as unknown as TUI;
  const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  const custom = <T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => Component | Promise<Component>): Promise<T> => {
    return new Promise<T>(resolve => { component = factory(tui, theme, {} as KeybindingsManager, resolve) as Component; });
  };
  const ctx = { mode: 'tui', ui: { custom } } as unknown as ExtensionCommandContext;
  return { ctx, component: () => { assert.ok(component); return component; } };
}

test('native Pi selector searches, preserves focus, opens once and fits narrow/wide terminals', async () => {
  const h = host();
  const result = choose(h.ctx, '管理器 / a long title', [{ label: 'alpha', value: 'a' }, { label: '中文 beta', value: 'b' }]);
  const component = h.component(); component.focused = true;
  component.handleInput!('/'); component.handleInput!('beta');
  for (const width of [12, 30, 90]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, line);
  component.handleInput!('\r'); // leave search without selecting
  component.handleInput!('\r');
  assert.equal(await result, 'b');
});

test('native Pi selector Escape clears search first then cancels', async () => {
  const h = host();
  const result = choose(h.ctx, 'Select', [{ label: 'alpha', value: 'a' }]);
  h.component().handleInput!('/');h.component().handleInput!('missing');
  h.component().handleInput!('\x1b');
  assert.ok(h.component().render(40).some(line => line.includes('alpha')));
  h.component().handleInput!('\x1b');
  assert.equal(await result, undefined);
});

test('native preview wraps to width, scrolls and completes without changing content', async () => {
  const h = host(); const result = view(h.ctx, 'Preview', '中文 preview\n'.repeat(50));
  const component = h.component();
  for (const line of component.render(15)) assert.ok(visibleWidth(line) <= 15, line);
  component.handleInput!('\x1b[6~');component.render(30);component.handleInput!('\x1b');
  await result;
});
