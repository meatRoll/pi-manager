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
    let visible: Array<{ value: string; label: string }> = [];
    const input = new Input();
    const makeList = (query: string) => {
      const items = labels.map((label, index) => ({ value: String(index), label }))
        .filter(item => item.label.toLowerCase().includes(query.toLowerCase()));
      visible = items;
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
          ...(searching ? input.render(width) : [truncateToWidth(theme.fg('muted', `Search: ${input.getValue() || '( ↑ from first row )'}`), width)]), '',
          ...list.render(width).map(line => truncateToWidth(line, width)), '', truncateToWidth(theme.fg('dim', '↑↓ select · Enter open · ↑ search · Esc back'), width)];
      },
      invalidate() { list.invalidate(); input.invalidate(); },
      handleInput(data: string) {
        const up = matchesKey(data, Key.up), down = matchesKey(data, Key.down);
        const pageUp = matchesKey(data, Key.pageUp), pageDown = matchesKey(data, Key.pageDown);
        if (searching && matchesKey(data, Key.escape)) {
          searching = false; input.focused = false; input.setValue(''); list = makeList('');
        } else if (!searching && matchesKey(data, Key.escape) && input.getValue()) {
          input.setValue(''); list = makeList('');
        } else if (searching && (up || down || pageUp || pageDown)) {
          searching = false; input.focused = false;
        } else if (searching) {
          input.handleInput(data); list = makeList(input.getValue());
        } else if (up) {
          const index = visible.findIndex(item => item.value === list.getSelectedItem()?.value);
          if (index <= 0) { searching = true; input.focused = focused; }
          else list.handleInput(data);
        } else list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

export interface ChecklistItem<T> {
  label: string;
  value: T;
  detail?: string;
  disabled?: boolean;
  selected?: boolean;
}

const lineText = (text: string) => plain(text).replace(/[\r\n\t]/g, ' ');

/** Multi-select companion to choose(). TUI uses Space/A/N; RPC falls back to
 * an explicit add-all / numbered-selection dialog because select() is single-value.
 */
export async function checklist<T>(ctx: ExtensionCommandContext, title: string, items: ChecklistItem<T>[], hint = ''): Promise<T[] | undefined> {
  const chosen = (indexes: Iterable<number>) => [...new Set([...indexes].filter(index => !items[index]?.disabled))].map(index => items[index].value);
  if (ctx.mode !== 'tui') {
    const fresh = items.map((item, index) => ({ item, index })).filter(entry => !entry.item.disabled);
    if (!fresh.length) { ctx.ui.notify('No new entries to select.', 'info'); return []; }
    const action = await ctx.ui.select(plain(title), [`Add all new (${fresh.length})`, 'Choose by number…', 'Cancel']);
    if (action?.startsWith('Add all new')) return chosen(fresh.map(entry => entry.index));
    if (action !== 'Choose by number…') return undefined;
    await view(ctx, title, items.map((item, index) => `${index + 1}. ${item.disabled ? '(configured) ' : ''}${item.label}${item.detail ? ` · ${item.detail}` : ''}`).join('\n'));
    const input = await ctx.ui.input('Models to add', '1,3,5-8 — blank adds none');
    if (input === undefined) return undefined;
    const text = input.trim();
    if (!text) return [];
    const indexes: number[] = [];
    for (const part of text.split(/[,\s]+/).filter(Boolean)) {
      const range = /^(\d+)-(\d+)$/.exec(part);
      if (range) {
        const start = Number(range[1]), end = Number(range[2]);
        for (let index = Math.min(start, end); index <= Math.max(start, end); index += 1) if (index >= 1 && index <= items.length) indexes.push(index - 1);
      } else if (/^\d+$/.test(part)) {
        const index = Number(part);
        if (index >= 1 && index <= items.length) indexes.push(index - 1);
      }
    }
    return chosen(indexes);
  }
  return ctx.ui.custom<T[] | undefined>((tui, theme, _keys, done) => {
    let searching = false, focused = false, finished = false;
    let height = 8, listHeight = 0, list: SelectList;
    let query = '';
    const selected = new Set<number>(items.map((item, index) => item.selected && !item.disabled ? index : -1).filter(index => index >= 0));
    const input = new Input();
    const filtered = () => items.map((item, index) => ({ item, index }))
      .filter(entry => plain(`${entry.item.label} ${entry.item.detail || ''}`).toLowerCase().includes(query.toLowerCase()));
    const finish = (result: T[] | undefined) => { if (!finished) { finished = true; done(result); } };
    const rebuild = () => {
      const visible = filtered();
      list = new SelectList(visible.map(entry => ({
        value: String(entry.index),
        label: entry.item.disabled ? `    ${lineText(entry.item.label)}` : `${selected.has(entry.index) ? '[x]' : '[ ]'} ${lineText(entry.item.label)}`,
        description: entry.item.detail ? lineText(entry.item.detail) : undefined,
      })), height, {
        selectedPrefix: text => theme.fg('accent', text), selectedText: text => theme.fg('accent', text),
        description: text => theme.fg('muted', text), scrollInfo: text => theme.fg('dim', text), noMatch: text => theme.fg('warning', text),
      }, { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 88 });
      list.onSelect = () => finish(chosen(selected));
      list.onCancel = () => finish(undefined);
      listHeight = height;
    };
    const move = (offset: number) => {
      const visible = filtered();
      const current = visible.findIndex(entry => String(entry.index) === list.getSelectedItem()?.value);
      list.setSelectedIndex(Math.max(0, Math.min(visible.length - 1, current + offset)));
    };
    input.setValue(query);
    input.onSubmit = () => { searching = false; input.focused = false; };
    rebuild();
    return {
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; input.focused = focused && searching; },
      render(width: number) {
        width = Math.max(1, width);
        height = Math.max(1, Math.min(14, (process.stdout.rows || 24) - 10));
        if (height !== listHeight) rebuild();
        const count = selected.size;
        return [truncateToWidth(theme.fg('accent', plain(title)), width), '',
          ...(searching ? input.render(width) : [truncateToWidth(theme.fg('muted', `Selected: ${count} · Search: ${query || '( ↑ from first row )'}`), width)]), '',
          ...list.render(width).map(line => truncateToWidth(line, width)), '',
          truncateToWidth(theme.fg('dim', `${hint ? `${hint} · ` : ''}↑↓ move · Space toggle · A all · N none · ↑ search · Enter confirm · Esc cancel`), width)];
      },
      invalidate() { list.invalidate(); input.invalidate(); },
      handleInput(data: string) {
        if (finished) return;
        const up = matchesKey(data, Key.up), down = matchesKey(data, Key.down), pageUp = matchesKey(data, Key.pageUp), pageDown = matchesKey(data, Key.pageDown);
        if (matchesKey(data, Key.escape)) {
          if (searching || query) { searching = false; input.focused = false; input.setValue(''); query = ''; rebuild(); }
          else finish(undefined);
        } else if (searching && matchesKey(data, Key.enter)) { searching = false; input.focused = false; }
        else if (searching && (up || down || pageUp || pageDown)) { searching = false; input.focused = false; }
        else if (searching) { input.handleInput(data); query = input.getValue(); rebuild(); }
        else if (up) {
          const index = filtered().findIndex(entry => String(entry.index) === list.getSelectedItem()?.value);
          if (index <= 0) { searching = true; input.focused = focused; input.setValue(query); }
          else move(-1);
        } else if (down || pageUp || pageDown) move(down ? 1 : pageUp ? -height : height);
        else if (matchesKey(data, Key.space)) {
          const index = Number(list.getSelectedItem()?.value);
          if (Number.isInteger(index) && !items[index].disabled) {
            if (selected.has(index)) selected.delete(index); else selected.add(index);
            rebuild();
          }
        } else if (matchesKey(data, 'a') || matchesKey(data, Key.shift('a'))) {
          items.forEach((item, index) => { if (!item.disabled) selected.add(index); });
          rebuild();
        } else if (matchesKey(data, 'n') || matchesKey(data, Key.shift('n'))) { selected.clear(); rebuild(); }
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
export async function working<T>(ctx: ExtensionCommandContext, label: string, action: () => Promise<T>, announce = true): Promise<T> {
  ctx.ui.setStatus('pi-manager-operation', plain(label));
  if (announce) ctx.ui.notify(label, 'info');
  try { return await action(); } finally { ctx.ui.setStatus('pi-manager-operation', undefined); }
}
