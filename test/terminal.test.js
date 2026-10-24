import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Terminal } from '../src/terminal.js';

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  input.setRawMode = () => {};
  output.rows = 24; output.columns = 80;
  output.resume();
  const ui = new Terminal(input, output);
  return { ui, input };
}

test('TUI retains every pasted character and Enter in one keypress batch', async () => {
  const { ui } = terminal();
  ui.start();
  const value = ui.inputText('Profile');
  for (const char of 'pasted-name') ui.onKey(char, { name: char });
  ui.onKey('\r', { name: 'return' });
  assert.equal(await value, 'pasted-name');
  ui.stop();
});

test('TUI searches, exits input mode and toggles selected result', async () => {
  const { ui } = terminal(); ui.start();
  const selection = ui.select('Resources', [{ label: 'alpha' }, { label: 'beta', toggle: true }]);
  ui.onKey('/', { name: '/' });
  for (const char of 'beta') ui.onKey(char, { name: char });
  ui.onKey('\r', { name: 'return' });
  ui.onKey(' ', { name: 'space' });
  assert.equal((await selection).entry.label, 'beta');
  ui.stop();
});
