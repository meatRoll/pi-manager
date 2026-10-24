import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-manager-real-pi-')));
process.env.PI_MANAGER_HOME = join(temp, 'manager');
const core = await import('../src/core.js');
const { publishBundle } = await import('../src/bundle.js');
const cli = process.env.PI_MANAGER_PI || 'pi';
const available = spawnSync(cli, ['--version'], { encoding: 'utf8', timeout: 15000 }).status === 0;
after(() => rm(temp, { recursive: true, force: true }));

interface RecordMessage {
  type: string;
  id?: string;
  method?: string;
  title?: string;
  success?: boolean;
  command?: string;
  data?: { disposition?: string; messageCount?: number; commands?: { name: string }[] };
}

test('official install loads a snapshot into real Pi; /manager returns to that same session without model calls', available ? { timeout: 60000 } : { skip: 'Pi CLI required' }, async () => {
  const project = join(temp, 'project'), agent = join(temp, 'agent');
  await mkdir(join(project, '.pi'), { recursive: true }); await mkdir(agent);
  const sentinel = '{"sentinel":"unchanged","packages":[]}\n'; await writeFile(join(project, '.pi/settings.json'), sentinel);
  await core.createProfile('preset');
  const resources = join(core.profilePath('preset'), 'resources');
  await mkdir(join(resources, 'skills/example'), { recursive: true });
  await mkdir(join(resources, 'prompts')); await mkdir(join(resources, 'extensions'));
  await writeFile(join(resources, 'skills/example/SKILL.md'), '---\nname: example\ndescription: A smoke test skill\n---\n# Example\n');
  await writeFile(join(resources, 'prompts/example.md'), 'Example template');
  await writeFile(join(resources, 'extensions/example.js'), 'export default function(pi) { pi.registerCommand("snapshot-example", {description: "test", handler: async (_args, ctx) => ctx.ui.notify("example")}); }');
  const settings = await core.getSettings('preset');
  settings.skills = ['resources/skills/example']; settings.prompts = ['resources/prompts/example.md']; settings.extensions = ['resources/extensions/example.js'];
  await core.saveSettings('preset', settings); await publishBundle('preset');
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(agent, 'sessions'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' };
  const installed = spawnSync(process.execPath, [fileURLToPath(new URL('../src/install-pi.js', import.meta.url)), '--yes'], { cwd: project, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  const configured = JSON.parse(await readFile(join(agent, 'settings.json'), 'utf8')) as { packages: string[] };
  assert.equal(configured.packages.length, 1);
  const child = spawn(cli, ['--mode', 'rpc', '--no-session', '--offline', '--no-approve'], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const records: RecordMessage[] = [];
  let buffered = '', stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index); buffered = buffered.slice(index + 1);
      if (line.trim()) records.push(JSON.parse(line) as RecordMessage);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n');
  const wait = async (predicate: (record: RecordMessage) => boolean): Promise<RecordMessage> => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const index = records.findIndex(predicate);
      if (index >= 0) return records.splice(index, 1)[0];
      assert.equal(child.exitCode, null, stderr);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Pi response timeout: ${stderr}`);
  };
  try {
    send({ id: 'commands', type: 'get_commands' });
    const commands = await wait(record => record.id === 'commands'); assert.equal(commands.success, true);
    const names = commands.data?.commands?.map(command => command.name) || [];
    assert.ok(names.includes('manager')); assert.ok(names.includes('snapshot-example'));
    assert.ok(names.includes('example')); assert.ok(names.includes('skill:example'));
    send({ id: 'manager', type: 'prompt', message: '/manager' });
    const dialog = await wait(record => record.type === 'extension_ui_request' && record.method === 'select');
    assert.match(dialog.title!, /loaded: preset/);
    send({ type: 'extension_ui_response', id: dialog.id, cancelled: true });
    const response = await wait(record => record.id === 'manager');
    assert.equal(response.success, true); assert.equal(response.data?.disposition, 'handled');
    send({ id: 'state', type: 'get_state' });
    assert.equal((await wait(record => record.id === 'state')).data?.messageCount, 0);
    child.stdin.end();
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr))); });
    assert.equal(stderr, '');
    assert.equal(await readFile(join(project, '.pi/settings.json'), 'utf8'), sentinel);
  } finally { if (child.exitCode === null) child.kill('SIGTERM'); }
});
