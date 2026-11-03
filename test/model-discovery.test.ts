import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DiscoveryError, describeDiscoveryPlan, executeDiscovery, fetchProviderModels, newDiscoveredModels,
  normalizeDiscoveredModels, planDiscovery, resolveTemplate, starterModel,
} from '../src/model-discovery.js';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from '../src/model-config.js';

const provider = (overrides: Record<string, unknown> = {}) => ({
  baseUrl: 'https://example.com/v1/',
  api: 'openai-completions',
  apiKey: 'sk-literal',
  ...overrides,
});

test('planDiscovery builds the models URL and auth headers without running commands', () => {
  const openai = planDiscovery(provider());
  assert.equal(openai.url, 'https://example.com/v1/models');
  assert.deepEqual(openai.authHeaders.map(item => item.header), ['Authorization']);
  assert.equal(openai.authHeaders[0].prefix, 'Bearer ');
  assert.match(openai.authLabel, /sk-l/);

  assert.equal(planDiscovery(provider({ baseUrl: 'https://example.com/v1/models/' })).url, 'https://example.com/v1/models');
  assert.equal(planDiscovery(provider(), 'https://custom.example/list').url, 'https://custom.example/list');
  assert.equal(planDiscovery(provider({ baseUrl: 'http://localhost:11434/v1' })).url, 'http://localhost:11434/v1/models');

  const anthropic = planDiscovery(provider({ api: 'anthropic-messages' }));
  assert.deepEqual(anthropic.authHeaders.map(item => item.header), ['x-api-key']);
  assert.equal(anthropic.headers['anthropic-version'], '2023-06-01');
  assert.equal(planDiscovery(provider({ api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' })).url, 'https://api.anthropic.com/v1/models');

  const google = planDiscovery(provider({ api: 'google-generative-ai' }));
  assert.deepEqual(google.authHeaders.map(item => item.header), ['x-goog-api-key']);

  const withHeaders = planDiscovery(provider({ headers: { 'X-Test': 'yes' } }));
  assert.equal(withHeaders.headers['X-Test'], 'yes');

  const commands = planDiscovery(provider({ apiKey: '!printf key', headers: { 'X-Key': '!printf header' } }));
  assert.equal(commands.commands.length, 2);
  assert.deepEqual(commands.commands.map(item => item.label), ['headers.X-Key', 'apiKey']);
  assert.match(describeDiscoveryPlan(commands), /Commands run locally/);
  assert.match(describeDiscoveryPlan(commands), /No files change/);
});

test('planDiscovery rejects missing, invalid, and OAuth endpoints', () => {
  assert.throws(() => planDiscovery({}), /no baseUrl/);
  assert.throws(() => planDiscovery(provider({ baseUrl: 'ftp://example.com' })), /http or https/);
  assert.throws(() => planDiscovery(provider({ baseUrl: 'not a url' })), /Invalid models URL/);
  assert.throws(() => planDiscovery(provider({ oauth: 'radius' })), /OAuth providers/);
});

test('resolveTemplate handles literals, environment variables, escapes, and commands', async () => {
  process.env.PI_MANAGER_TEST_KEY = 'from-env';
  try {
    assert.equal(await resolveTemplate('literal'), 'literal');
    assert.equal(await resolveTemplate('$PI_MANAGER_TEST_KEY'), 'from-env');
    assert.equal(await resolveTemplate('${PI_MANAGER_TEST_KEY}'), 'from-env');
    assert.equal(await resolveTemplate('prefix-$PI_MANAGER_TEST_KEY'), 'prefix-from-env');
    assert.equal(await resolveTemplate('$$PI_MANAGER_TEST_KEY'), '$PI_MANAGER_TEST_KEY');
    assert.equal(await resolveTemplate('$!command'), '!command');
    await assert.rejects(resolveTemplate('$PI_MANAGER_MISSING_KEY'), /is not set/);
    await assert.rejects(resolveTemplate('!printf key'), /without confirmation/);
    if (process.platform !== 'win32') {
      assert.equal(await resolveTemplate('!printf command-key', { allowCommands: true }), 'command-key');
      await assert.rejects(resolveTemplate('!printf "a\\nb"', { allowCommands: true }), /more than one line/);
    }
  } finally { delete process.env.PI_MANAGER_TEST_KEY; }
});

test('normalizeDiscoveredModels accepts OpenAI, Anthropic, Google, and array shapes', () => {
  const openai = normalizeDiscoveredModels({
    data: [
      {
        id: 'alpha', name: 'Alpha', context_length: 200000, max_completion_tokens: 32000,
        capabilities: { reasoning: true }, architecture: { input_modalities: ['text', 'image'] },
      },
      { id: 'beta', context_length: '64000', supported_parameters: ['reasoning'] },
    ],
  });
  assert.deepEqual(openai.map(model => model.id), ['alpha', 'beta']);
  assert.equal(openai[0].name, 'Alpha');
  assert.equal(openai[0].contextWindow, 200000);
  assert.equal(openai[0].maxTokens, 32000);
  assert.equal(openai[0].reasoning, true);
  assert.deepEqual(openai[0].input, ['text', 'image']);
  assert.equal(openai[1].contextWindow, 64000);
  assert.equal(openai[1].reasoning, true);

  const anthropic = normalizeDiscoveredModels({ data: [{ id: 'claude', display_name: 'Claude Test' }] });
  assert.equal(anthropic[0].name, 'Claude Test');

  const google = normalizeDiscoveredModels({
    models: [{ name: 'models/gemini-test', displayName: 'Gemini Test', inputTokenLimit: 1000000, outputTokenLimit: 8192 }],
  });
  assert.equal(google[0].id, 'gemini-test');
  assert.equal(google[0].name, 'Gemini Test');
  assert.equal(google[0].contextWindow, 1000000);
  assert.equal(google[0].maxTokens, 8192);

  const array = normalizeDiscoveredModels(['one', { id: 'two' }]);
  assert.deepEqual(array.map(model => model.id), ['one', 'two']);

  const merged = normalizeDiscoveredModels({
    data: [{ id: 'same', context_length: 1000 }, { id: 'same', name: 'Same', max_completion_tokens: 100 }],
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].contextWindow, 1000);
  assert.equal(merged[0].maxTokens, 100);
  assert.equal(merged[0].name, 'Same');

  assert.throws(() => normalizeDiscoveredModels({ error: 'bad' }), /no data or models array/);
  assert.throws(() => normalizeDiscoveredModels(null), /no data or models array/);
});

test('starterModel fills Pi defaults and clamps output to the context window', () => {
  const inferred = starterModel({ id: 'alpha', name: 'Alpha', contextWindow: 200000, maxTokens: 32000, reasoning: true, input: ['text', 'image'] });
  assert.deepEqual(inferred, {
    id: 'alpha', name: 'Alpha', reasoning: true, input: ['text', 'image'],
    contextWindow: 200000, maxTokens: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const defaults = starterModel({ id: 'beta' });
  assert.equal(defaults.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(defaults.maxTokens, DEFAULT_MAX_TOKENS);
  assert.equal(defaults.reasoning, false);
  assert.deepEqual(defaults.input, ['text']);
  assert.equal(defaults.name, undefined);
  const clamped = starterModel({ id: 'small', contextWindow: 1000, maxTokens: 2000 });
  assert.equal(clamped.maxTokens, 1000);

  const provider = { baseUrl: 'https://example.com', models: [{ id: 'alpha' }] };
  const added = newDiscoveredModels(provider, [{ id: 'alpha' }, { id: 'beta' }]);
  assert.deepEqual(added.map(model => model.id), ['beta']);
});

test('executeDiscovery sends resolved headers and reports the response', async () => {
  process.env.PI_MANAGER_TEST_KEY = 'env-key';
  try {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(input), headers: init?.headers as Record<string, string> };
      return new Response(JSON.stringify({ data: [{ id: 'alpha', context_length: 2000 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const plan = planDiscovery(provider({ apiKey: '$PI_MANAGER_TEST_KEY', headers: { 'X-Test': 'value' } }));
    const result = await executeDiscovery(plan, { fetchImpl });
    assert.equal(seen?.url, 'https://example.com/v1/models');
    assert.equal(seen?.headers.Authorization, 'Bearer env-key');
    assert.equal(seen?.headers['X-Test'], 'value');
    assert.equal(result.status, 200);
    assert.equal(result.models[0].id, 'alpha');
  } finally { delete process.env.PI_MANAGER_TEST_KEY; }
});

test('executeDiscovery surfaces HTTP and JSON failures without touching files', async () => {
  const failing = (async () => new Response('nope', { status: 401 })) as typeof fetch;
  await assert.rejects(executeDiscovery(planDiscovery(provider()), { fetchImpl: failing }), (error: unknown) => {
    assert.ok(error instanceof DiscoveryError);
    assert.equal(error.status, 401);
    assert.equal(error.body, 'nope');
    return true;
  });
  const html = (async () => new Response('<html>no</html>', { status: 200 })) as typeof fetch;
  await assert.rejects(executeDiscovery(planDiscovery(provider()), { fetchImpl: html }), /did not return JSON/);
  const wrongShape = (async () => new Response(JSON.stringify({ error: 'bad' }), { status: 200 })) as typeof fetch;
  await assert.rejects(executeDiscovery(planDiscovery(provider()), { fetchImpl: wrongShape }), /no data or models array/);
});

test('fetchProviderModels marks configured models and fresh additions', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }] }), { status: 200 })) as typeof fetch;
  const result = await fetchProviderModels(provider({ models: [{ id: 'alpha' }] }), { fetchImpl });
  assert.equal(result.models.length, 2);
  assert.equal(result.configured, 1);
  assert.equal(result.fresh, 1);
});
