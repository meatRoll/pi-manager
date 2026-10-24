import readline from 'node:readline';
import type { Key } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface TerminalInput extends Readable {
  isTTY?: boolean;
  setRawMode(mode: boolean): unknown;
}
export interface TerminalOutput extends Writable { isTTY?: boolean; rows?: number; columns?: number }
export interface MenuEntry { label: string; detail?: string; toggle?: boolean }
export interface KeyEvent { text: string | undefined; key: Key }

// Remove terminal controls from all untrusted metadata/content before rendering.
export function plain(text: unknown) {
  return String(text ?? '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
export function clip(text: unknown, width: number) {
  let result = '', used = 0;
  for (const char of plain(text).replace(/[\r\n\t]/g, ' ')) {
    const cells = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\u{1f300}-\u{1faff}]/u.test(char) ? 2 : /\p{Mark}/u.test(char) ? 0 : 1;
    if (used + cells > width) break;
    result += char; used += cells;
  }
  return result;
}

export class Terminal {
  input: TerminalInput;
  output: TerminalOutput;
  pending: ((event: KeyEvent) => void) | null;
  active: boolean;
  queue: KeyEvent[];
  redraw: (() => void) | null = null;
  onKey: (text: string | undefined, key?: Key) => void;
  onResize: () => void;

  constructor(input: TerminalInput = process.stdin, output: TerminalOutput = process.stdout) {
    this.input = input; this.output = output; this.pending = null; this.active = false; this.queue = [];
    this.onKey = (text, key = {}) => {
      const event = key.ctrl && key.name === 'c' ? { text: '', key: { name: 'escape' } } : { text, key };
      if (this.pending) this.pending(event);
      else if (this.queue.length < 65536) this.queue.push(event);
    };
    this.onResize = () => this.redraw?.();
  }
  start() {
    if (!this.input.isTTY || !this.output.isTTY) throw new Error('TUI requires an interactive terminal. Use --help for CLI commands.');
    if (this.active) return;
    this.active = true;
    readline.emitKeypressEvents(this.input);
    this.input.setRawMode(true); this.input.resume();
    this.input.on('keypress', this.onKey); this.output.on('resize', this.onResize);
    this.output.write('\x1b[?1049h\x1b[?25l');
  }
  stop() {
    if (!this.active) return;
    this.active = false; this.pending = null; this.redraw = null; this.queue = [];
    this.input.off('keypress', this.onKey); this.output.off('resize', this.onResize);
    this.input.setRawMode(false); this.input.pause();
    this.output.write('\x1b[?25h\x1b[?1049l');
  }
  async suspend<T>(action: () => T | Promise<T>): Promise<T> {
    this.stop();
    try { return await action(); } finally { this.start(); }
  }
  key(): Promise<KeyEvent> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    return new Promise<KeyEvent>(resolve => { this.pending = result => { this.pending = null; resolve(result); }; });
  }
  draw(title: string, lines: string[], footer = '') {
    const width = Math.max(20, this.output.columns || 80);
    const height = Math.max(6, this.output.rows || 24);
    const rows = [clip(` pi-manager  /  ${title}`, width), '─'.repeat(width), ...lines.slice(0, height - 4).map(line => clip(line, width))];
    while (rows.length < height - 1) rows.push('');
    rows.push(clip(footer, width));
    this.output.write('\x1b[H\x1b[2J' + rows.join('\r\n'));
  }
  async select<T extends MenuEntry>(title: string, entries: T[], hint = ''): Promise<{ entry: T; action: 'open' | 'toggle' } | null> {
    let selected = 0, query = '', searching = false;
    const matches = () => entries.filter(entry => plain(`${entry.label} ${entry.detail || ''}`).toLowerCase().includes(query.toLowerCase()));
    this.redraw = () => {
      const items = matches(); selected = Math.min(selected, Math.max(0, items.length - 1));
      const capacity = Math.max(1, (this.output.rows || 24) - 8);
      const start = Math.max(0, selected - capacity + 1);
      this.draw(title, [hint, ` Search: ${query}${searching ? '▏' : ''}`, '', ...items.slice(start, start + capacity).map((entry, index) => `${start + index === selected ? ' ›' : '  '} ${entry.label}  ${entry.detail || ''}`),
        ...(items.length ? [] : ['  No matching entries'])], ' ↑↓ navigate · Enter open · / search · Space toggle · Esc back');
    };
    try {
      while (true) {
        this.redraw(); const { text, key } = await this.key();
        if (key.name === 'escape') { if (searching || query) { searching = false; query = ''; } else return null; }
        else if (key.name === 'up') selected = Math.max(0, selected - 1);
        else if (key.name === 'down') selected = Math.min(matches().length - 1, selected + 1);
        else if (key.name === 'pageup') selected = Math.max(0, selected - 10);
        else if (key.name === 'pagedown') selected = Math.min(matches().length - 1, selected + 10);
        else if (key.name === 'return') { if (searching) searching = false; else if (matches()[selected]) return { entry: matches()[selected], action: 'open' }; }
        else if (text === ' ' && !searching && matches()[selected]?.toggle) return { entry: matches()[selected], action: 'toggle' };
        else if (text === '/' && !searching) searching = true;
        else if (key.name === 'backspace') query = [...query].slice(0, -1).join('');
        else if (text && !key.ctrl && !key.meta && (searching || /^[\p{L}\p{N}_.-]$/u.test(text))) { query += plain(text); selected = 0; }
      }
    } finally { this.redraw = null; }
  }
  async inputText(title: string, hint = '', initial = '') {
    let value = initial;
    this.redraw = () => this.draw(title, [hint, '', ` > ${value}▏`], ' Enter confirm · Esc cancel');
    try {
      while (true) {
        this.redraw(); const { text, key } = await this.key();
        if (key.name === 'escape') return null;
        if (key.name === 'return') return value.trim();
        if (key.name === 'backspace') value = [...value].slice(0, -1).join('');
        else if (text && !key.ctrl && !key.meta) value += plain(text).replace(/[\r\n]/g, '');
      }
    } finally { this.redraw = null; }
  }
  async confirm(title: string, message: string) {
    const chosen = await this.select(title, [{ label: 'Cancel', value: false }, { label: 'Confirm', value: true }], message);
    return chosen?.entry.value === true;
  }
  async view(title: string, text: unknown) {
    const lines = plain(text).split(/\r?\n/); let offset = 0, column = 0;
    this.redraw = () => this.draw(title, lines.slice(offset).map(line => [...line].slice(column).join('')), ' ↑↓/PgUp/PgDn scroll · ←→ horizontal · Esc back');
    try {
      while (true) {
        this.redraw(); const { key } = await this.key();
        if (key.name === 'escape' || key.name === 'return') return;
        if (key.name === 'up') offset = Math.max(0, offset - 1);
        if (key.name === 'down') offset = Math.min(Math.max(0, lines.length - 1), offset + 1);
        if (key.name === 'pageup') offset = Math.max(0, offset - 15);
        if (key.name === 'pagedown') offset = Math.min(Math.max(0, lines.length - 1), offset + 15);
        if (key.name === 'left') column = Math.max(0, column - 10);
        if (key.name === 'right') column += 10;
      }
    } finally { this.redraw = null; }
  }
}
