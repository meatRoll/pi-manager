import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Text, Input, SelectList, Key, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';
import { plain } from './terminal.js';

export interface Choice<T> { label: string; value: T }
export async function choose<T>(ctx: ExtensionCommandContext, title: string, choices: Choice<T>[]): Promise<T | undefined> {
  // Prefix indices to keep distinct resources selectable even with equal names.
  const labels = choices.map((item, index) => `${index + 1}. ${plain(item.label).replace(/[\r\n]/g, ' ')}`);
  if (ctx.mode !== 'tui') {
    const selected = await ctx.ui.select(plain(title), labels);
    const index = selected === undefined ? -1 : labels.indexOf(selected);
    return index < 0 ? undefined : choices[index].value;
  }
  return ctx.ui.custom<T | undefined>((tui, theme, _keys, done) => {
    let searching = false, focused = false;
    const input = new Input();
    const makeList = (query: string) => {
      const items = labels.map((label, index) => ({ value: String(index), label }))
        .filter(item => item.label.toLowerCase().includes(query.toLowerCase()));
      const result = new SelectList(items, Math.max(1, Math.min(12, (process.stdout.rows || 24) - 12)), {
        selectedPrefix: text => theme.fg('accent', text), selectedText: text => theme.fg('accent', text),
        description: text => theme.fg('muted', text), scrollInfo: text => theme.fg('dim', text), noMatch: text => theme.fg('warning', text),
      });
      result.onSelect = item => done(choices[Number(item.value)].value);
      result.onCancel = () => done(undefined);
      return result;
    };
    let list = makeList('');
    input.onSubmit = () => { searching = false; input.focused = false; };
    return {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; input.focused = focused && searching; },
      render(width: number) {
        return [truncateToWidth(theme.fg('accent', plain(title)), width), '',
          ...(searching ? input.render(width) : [truncateToWidth(theme.fg('muted', `Search: ${input.getValue()}`), width)]), '',
          ...list.render(width).map(line => truncateToWidth(line, width)), '', truncateToWidth(theme.fg('dim', '↑↓ select · Enter open · / search · Esc back'), width)];
      },
      invalidate() { list.invalidate(); input.invalidate(); },
      handleInput(data: string) {
        if (data === '/' && !searching) { searching = true; input.focused = focused; }
        else if (searching && matchesKey(data, Key.escape)) { searching = false; input.focused = false; input.setValue(''); list = makeList(''); }
        else if (searching && ![Key.up, Key.down, Key.pageUp, Key.pageDown].some(key => matchesKey(data, key))) { input.handleInput(data); list = makeList(input.getValue()); }
        else list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

export async function view(ctx: ExtensionCommandContext, title: string, content: unknown): Promise<void> {
  if (ctx.mode !== 'tui') {
    await ctx.ui.select(`${plain(title)}\n${plain(content).slice(0, 16000)}`, ['Back']);
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    let offset = 0, total = 0, height = 1;
    const text = new Text(plain(content).slice(0, 128 * 1024), 0, 0);
    return {
      render(width: number) {
        const lines = text.render(Math.max(1, width)); total = lines.length;
        height = Math.max(1, (process.stdout.rows || 24) - 10);
        offset = Math.min(offset, Math.max(0, total - height));
        return [truncateToWidth(theme.fg('accent', `pi-manager / ${plain(title)}`), width), '',
          ...lines.slice(offset, offset + height), '',
          truncateToWidth(theme.fg('dim', '↑↓ / PgUp / PgDn scroll · Enter / Esc back'), width)];
      },
      invalidate() { text.invalidate(); },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) { done(); return; }
        if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
        if (matchesKey(data, Key.down)) offset = Math.min(Math.max(0, total - height), offset + 1);
        if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - height);
        if (matchesKey(data, Key.pageDown)) offset = Math.min(Math.max(0, total - height), offset + height);
        tui.requestRender();
      },
    };
  });
}

/** Status feedback only; never writes subprocess output into Pi's terminal. */
export async function working<T>(ctx: ExtensionCommandContext, label: string, action: () => Promise<T>): Promise<T> {
  ctx.ui.setStatus('pi-manager-operation', plain(label));
  ctx.ui.notify(label, 'info');
  try { return await action(); } finally { ctx.ui.setStatus('pi-manager-operation', undefined); }
}
