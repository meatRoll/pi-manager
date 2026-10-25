import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Input, SelectList, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { choose } from './pi-ui.js';
import { plain } from './terminal.js';

export type DashboardTab = 'all' | 'extensions' | 'skills' | 'context' | 'packages' | 'more' | 'prompts' | 'themes';
const tabs: { id: DashboardTab; label: string; short: string }[] = [
  { id: 'all', label: 'All', short: 'All' },
  { id: 'extensions', label: 'Extensions', short: 'Ext' },
  { id: 'skills', label: 'Skills', short: 'Skills' },
  { id: 'context', label: 'Context', short: 'Ctx' },
  { id: 'packages', label: 'Packages', short: 'Pkgs' },
  { id: 'more', label: 'More', short: 'More' },
];
const extraTabs = [
  { id: 'prompts', label: 'Prompt templates', short: 'Prompts' },
  { id: 'themes', label: 'Themes', short: 'Themes' },
] as const;
export interface DashboardEntry {
  id: string;
  label: string;
  detail?: string;
  toggle?: boolean;
  editable?: boolean;
  deletable?: boolean;
}
export interface DashboardModel {
  profile: string;
  loading: string;
  publication: string;
  pending: boolean | undefined;
  busy?: boolean;
  error?: string;
  rows: Record<DashboardTab, DashboardEntry[]>;
}
export type DashboardLoader = (update: (model: DashboardModel) => void, signal: AbortSignal) => Promise<void>;
export interface DashboardState {
  tab: DashboardTab;
  views: Partial<Record<DashboardTab, { query: string; selected?: string }>>;
}
export const newDashboardState = (): DashboardState => ({ tab: 'all', views: {} });
export type DashboardAction =
  | { kind: 'open'; id: string }
  | { kind: 'toggle'; id: string }
  | { kind: 'edit'; id: string }
  | { kind: 'delete'; id: string }
  | { kind: 'add' }
  | { kind: 'publish' }
  | { kind: 'switch' }
  | { kind: 'refresh' };

const lineText = (text: string) => plain(text).replace(/[\r\n\t]/g, ' ');
const tabLabel = (tab: DashboardTab) => [...tabs, ...extraTabs].find(item => item.id === tab)!.label;

/** Show the native shell immediately; read-only discovery/checks may update it.
 * Disk mutations still happen only after this interaction closes.
 */
export async function dashboard(ctx: ExtensionCommandContext, model: DashboardModel, state: DashboardState, load?: DashboardLoader): Promise<DashboardAction | undefined> {
  const controller = new AbortController();
  let background = Promise.resolve();
  const rpc = async () => {
    // RPC clients cannot render custom components or forward panel shortcuts.
    // Keep the same flat rows and offer explicit navigation/actions as dialogs.
    // Completed checks are reflected in the next dialog, never by opening an
    // unsolicited second select over the one the client is already answering.
    if (load) background = Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      return load(next => { if (!controller.signal.aborted) model = next; }, controller.signal);
    }).catch(() => {});
    while (true) {
      const action = await choose<DashboardAction | { tab: DashboardTab }>(ctx,
        `pi-manager / ${model.profile} / ${tabLabel(state.tab)} — staging\n${model.loading}\n${model.publication}`, [
          ...[...tabs, ...extraTabs].filter(tab => tab.id !== state.tab).map(tab => ({ label: `Tab: ${tab.label}`, value: { tab: tab.id } })),
          { label: 'Switch preset', value: { kind: 'switch' } },
          { label: '+ Add resource / package', value: { kind: 'add' } },
          { label: 'Publish for next Pi start', value: { kind: 'publish' } },
          { label: 'Refresh staging metadata', value: { kind: 'refresh' } },
          ...model.rows[state.tab].map(row => ({ label: `${row.label}${row.detail ? ` · ${row.detail}` : ''}`, value: { kind: 'open' as const, id: row.id } })),
        ]);
      if (action && 'tab' in action) { state.tab = action.tab; continue; }
      return action;
    }
  };
  const terminal = () => ctx.ui.custom<DashboardAction | undefined>((tui, theme, keys, done) => {
    let focused = false, searching = false, finished = false;
    let height = 8, listHeight = 0;
    let filtered: DashboardEntry[] = [];
    let list: SelectList;
    const input = new Input();
    const currentView = () => state.views[state.tab] ||= { query: '' };
    const selected = () => filtered.find(row => row.id === list.getSelectedItem()?.value);
    const saveSelection = () => { currentView().selected = list.getSelectedItem()?.value; };
    const finish = (result: DashboardAction | undefined) => {
      if (!finished) { finished = true; saveSelection(); controller.abort(); done(result); }
    };
    const rebuild = () => {
      const view = currentView(), query = view.query.toLowerCase();
      filtered = model.rows[state.tab].filter(row => lineText(`${row.label} ${row.detail || ''}`).toLowerCase().includes(query));
      listHeight = height;
      list = new SelectList(filtered.map(row => ({ value: row.id, label: lineText(row.label), description: row.detail ? lineText(row.detail) : undefined })), height, {
        selectedPrefix: text => theme.fg('accent', text), selectedText: text => theme.fg('accent', text),
        description: text => theme.fg('muted', text), scrollInfo: text => theme.fg('dim', text), noMatch: text => theme.fg('warning', text),
      }, { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 88 });
      list.setSelectedIndex(Math.max(0, filtered.findIndex(row => row.id === view.selected)));
      list.onSelectionChange = saveSelection;
      list.onSelect = item => finish({ kind: 'open', id: item.value });
      saveSelection();
    };
    const changeTab = (offset: number) => {
      saveSelection();
      const available = [...tabs, ...extraTabs.filter(tab => tab.id === state.tab)];
      const index = available.findIndex(tab => tab.id === state.tab);
      state.tab = available[(index + offset + available.length) % available.length].id;
      searching = false; input.focused = false; input.setValue(currentView().query); rebuild();
    };
    const move = (offset: number) => {
      const index = filtered.findIndex(row => row.id === list.getSelectedItem()?.value);
      list.setSelectedIndex(Math.max(0, Math.min(filtered.length - 1, index + offset))); saveSelection();
    };
    const renderTabs = (width: number) => {
      const available = [...tabs, ...extraTabs.filter(tab => tab.id === state.tab)];
      const labels = (short: boolean) => available.map(tab => tab.id === state.tab
        ? theme.fg('accent', `[${short ? tab.short : tab.label}]`) : theme.fg('muted', short ? tab.short : tab.label)).join('  ');
      const full = labels(false), compact = labels(true);
      return visibleWidth(full) <= width ? full : visibleWidth(compact) <= width ? compact : `← [${tabLabel(state.tab)}] →`;
    };
    input.setValue(currentView().query);
    input.onSubmit = () => { searching = false; input.focused = false; };
    rebuild();
    if (load) background = Promise.resolve().then(() => {
      if (finished || controller.signal.aborted) return;
      return load(next => {
        if (finished || controller.signal.aborted) return;
        saveSelection(); model = next; rebuild(); tui.requestRender();
      }, controller.signal);
    }).catch(error => {
      if (finished || controller.signal.aborted) return;
      model = { ...model, busy: false, error: error instanceof Error ? error.message : String(error) };
      tui.requestRender();
    });
    return {
      dispose() { finished = true; controller.abort(); },
      get focused() { return focused; },
      set focused(value: boolean) { focused = value; input.focused = focused && searching; },
      render(width: number) {
        width = Math.max(1, width);
        const hintText = width < 50 ? '←→ Tab · ↑↓ select\nSpace toggle · Enter view\nE edit · A add · P publish\nS presets · / search · Esc' : '↑↓ select · ←→ / Tab category · Space toggle · Enter preview / actions\nE edit · Del delete · A add · P publish · S switch preset · R refresh · / search · Esc close';
        const hints = wrapTextWithAnsi(hintText, width);
        const header = [theme.fg('accent', `pi-manager / ${model.profile}    [S switch preset]`),
          theme.fg('muted', lineText(model.loading)), theme.fg(model.pending ? 'warning' : 'muted', lineText(model.publication)),
          renderTabs(width),
          ...(searching ? input.render(width) : [theme.fg('dim', `Search: ${lineText(currentView().query) || '( / to search )'}`)]), ''];
        // Leave room for Pi's editor/footer and the SelectList scroll indicator.
        height = Math.max(1, Math.min(12, (process.stdout.rows || 24) - header.length - hints.length - 8));
        if (height !== listHeight) rebuild();
        const row = selected();
        const empty = model.error ? `Cannot read staging metadata: ${lineText(model.error)} · R retry / S switch preset`
          : model.busy ? 'Reading resource metadata… You can change category, search, or press Esc.'
          : currentView().query ? 'No matching entries. Esc clears search.' : 'No entries. Press A to add a resource or package.';
        return [...header, ...(filtered.length ? list.render(width) : [theme.fg(model.error ? 'warning' : 'dim', empty)]), '',
          theme.fg('muted', row ? `${lineText(row.label)}${row.detail ? ` · ${lineText(row.detail)}` : ''}` : ''),
          ...hints.map(line => theme.fg('dim', line))].map(line => truncateToWidth(line, width));
      },
      invalidate() { list.invalidate(); input.invalidate(); },
      handleInput(data: string) {
        if (finished) return;
        const cancel = keys.matches(data, 'tui.select.cancel');
        const up = keys.matches(data, 'tui.select.up'), down = keys.matches(data, 'tui.select.down');
        const pageUp = keys.matches(data, 'tui.select.pageUp'), pageDown = keys.matches(data, 'tui.select.pageDown');
        if (cancel) {
          if (searching || currentView().query) { searching = false; input.focused = false; input.setValue(''); currentView().query = ''; rebuild(); }
          else finish(undefined);
        } else if (searching && keys.matches(data, 'tui.select.confirm')) { searching = false; input.focused = false; }
        else if (searching && !up && !down && !pageUp && !pageDown) {
          input.handleInput(data); currentView().query = input.getValue(); rebuild();
        } else if (up || down || pageUp || pageDown) move(up ? -1 : down ? 1 : pageUp ? -height : height);
        else if (keys.matches(data, 'tui.select.confirm')) { const row = selected(); if (row) finish({ kind: 'open', id: row.id }); }
        else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) changeTab(1);
        else if (matchesKey(data, Key.left) || matchesKey(data, Key.shift(Key.tab))) changeTab(-1);
        else if (matchesKey(data, Key.slash)) { searching = true; input.focused = focused; }
        else if (!model.busy && !model.error && (matchesKey(data, 'a') || matchesKey(data, Key.shift('a')))) finish({ kind: 'add' });
        else if (!model.busy && !model.error && (matchesKey(data, 'p') || matchesKey(data, Key.shift('p')))) finish({ kind: 'publish' });
        else if (matchesKey(data, 's') || matchesKey(data, Key.shift('s'))) finish({ kind: 'switch' });
        else if (matchesKey(data, 'r') || matchesKey(data, Key.shift('r'))) finish({ kind: 'refresh' });
        else {
          const row = selected();
          if (row?.toggle && matchesKey(data, Key.space)) finish({ kind: 'toggle', id: row.id });
          else if (row?.editable && (matchesKey(data, 'e') || matchesKey(data, Key.shift('e')))) finish({ kind: 'edit', id: row.id });
          else if (row?.deletable && matchesKey(data, Key.delete)) finish({ kind: 'delete', id: row.id });
        }
        tui.requestRender();
      },
    };
  });
  try { return await (ctx.mode === 'tui' ? terminal() : rpc()); }
  finally {
    controller.abort();
    // Do not leave workers/hashing behind or let stale results reach a new view.
    await background;
  }
}
