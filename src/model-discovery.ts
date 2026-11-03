import { execFile } from 'node:child_process';
import { errorMessage } from './errors.js';
import {
  DEFAULT_CONTEXT_WINDOW, DEFAULT_COST, DEFAULT_MAX_TOKENS, maskSecret,
} from './model-config.js';
import type { InputModality, JsonObject, ModelDefinition, ProviderDefinition } from './model-config.js';

export interface DiscoveryCommand {
  label: string;
  command: string;
}

export interface DiscoveryAuthHeader {
  header: string;
  template: string;
  prefix?: string;
  label: string;
}

export interface DiscoveryPlan {
  url: string;
  headers: Record<string, string>;
  authHeaders: DiscoveryAuthHeader[];
  commands: DiscoveryCommand[];
  authLabel: string;
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: InputModality[];
}

export interface DiscoveryResult {
  url: string;
  status: number;
  elapsedMs: number;
  models: DiscoveredModel[];
  configured: number;
  fresh: number;
}

export interface ExecuteDiscoveryOptions {
  allowCommands?: boolean;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface FetchModelsOptions extends ExecuteDiscoveryOptions {
  modelsUrl?: string;
}

export class DiscoveryError extends Error {
  readonly url: string;
  readonly status?: number;
  readonly body?: string;
  constructor(message: string, url: string, status?: number, body?: string) {
    super(message);
    this.name = 'DiscoveryError';
    this.url = url;
    this.status = status;
    this.body = body;
  }
}

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const firstString = (...values: unknown[]) => values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
const positive = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim()) && Number(value) > 0) return Number(value);
  }
  return undefined;
};

function buildModelsUrl(provider: ProviderDefinition, modelsUrl?: string): string {
  const explicit = modelsUrl?.trim();
  const base = explicit || provider.baseUrl?.trim();
  if (!base) throw new Error('Provider has no baseUrl. Set a Models URL or edit the provider first.');
  const trimmed = base.replace(/\/+$/, '');
  const anthropic = (provider.api ?? '').toLowerCase() === 'anthropic-messages';
  const suffix = anthropic && !/\/v1$/i.test(trimmed) ? '/v1/models' : '/models';
  const url = explicit ? base : /\/models$/i.test(trimmed) ? trimmed : `${trimmed}${suffix}`;
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new Error(`Invalid models URL: ${url}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Models URL must use http or https.');
  return parsed.href;
}

function collectCommand(commands: DiscoveryCommand[], seen: Set<string>, label: string, value: string | undefined) {
  if (!value?.startsWith('!')) return;
  const command = value.slice(1).trim();
  if (!command || seen.has(`${label}\0${command}`)) return;
  seen.add(`${label}\0${command}`);
  commands.push({ label, command });
}

/** Build the request without running commands or touching the network. */
export function planDiscovery(provider: ProviderDefinition, modelsUrl?: string): DiscoveryPlan {
  if (provider.oauth) throw new Error('OAuth providers cannot use endpoint discovery. Add models manually or use the provider login.');
  const url = buildModelsUrl(provider, modelsUrl);
  const commands: DiscoveryCommand[] = [];
  const seen = new Set<string>();
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(provider.headers ?? {})) {
    if (typeof value !== 'string') throw new Error(`Provider header ${name} must be a string`);
    headers[name] = value;
    collectCommand(commands, seen, `headers.${name}`, value);
  }
  headers.Accept ??= 'application/json';
  const key = provider.apiKey;
  collectCommand(commands, seen, 'apiKey', key);
  const api = (provider.api ?? '').toLowerCase();
  const authHeaders: DiscoveryAuthHeader[] = [];
  if (key) {
    if (api === 'anthropic-messages') {
      if (!('anthropic-version' in headers)) headers['anthropic-version'] = '2023-06-01';
      if (!('x-api-key' in headers)) authHeaders.push({ header: 'x-api-key', template: key, label: `x-api-key ${maskSecret(key)}` });
      if (provider.authHeader && !('Authorization' in headers)) {
        authHeaders.push({ header: 'Authorization', template: key, prefix: 'Bearer ', label: `Authorization Bearer ${maskSecret(key)}` });
      }
    } else if (api === 'google-generative-ai') {
      if (!('x-goog-api-key' in headers)) authHeaders.push({ header: 'x-goog-api-key', template: key, label: `x-goog-api-key ${maskSecret(key)}` });
      if (provider.authHeader && !('Authorization' in headers)) {
        authHeaders.push({ header: 'Authorization', template: key, prefix: 'Bearer ', label: `Authorization Bearer ${maskSecret(key)}` });
      }
    } else if (!('Authorization' in headers)) {
      authHeaders.push({ header: 'Authorization', template: key, prefix: 'Bearer ', label: `Authorization Bearer ${maskSecret(key)}` });
    }
  }
  return {
    url,
    headers,
    authHeaders,
    commands,
    authLabel: authHeaders.map(item => item.label).join(' · ') || '(no auth)',
  };
}

function runShell(command: string, options: ExecuteDiscoveryOptions): Promise<string> {
  const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
  return new Promise((resolve, reject) => {
    execFile(shell, args, {
      timeout: 10_000, maxBuffer: 1024 * 1024, cwd: options.cwd, env: options.env ?? process.env, encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error(`Auth command failed: ${String(stderr || error.message).trim()}`)); return; }
      const result = String(stdout).trim();
      if (!result) { reject(new Error('Auth command returned no output')); return; }
      if (/[\r\n]/.test(result)) { reject(new Error('Auth command returned more than one line')); return; }
      resolve(result);
    });
  });
}

/** Resolve a literal, $ENV / ${ENV} value, or a leading !command. */
export async function resolveTemplate(template: string, options: ExecuteDiscoveryOptions = {}): Promise<string> {
  if (template.startsWith('!')) {
    if (!options.allowCommands) throw new Error('Refusing to run an auth command without confirmation.');
    return runShell(template.slice(1).trim(), options);
  }
  return template.replace(/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, braced: string | undefined, bare: string | undefined) => {
      if (match === '$$') return '$';
      if (match === '$!') return '!';
      const name = braced ?? bare ?? '';
      const value = (options.env ?? process.env)[name];
      if (value === undefined) throw new Error(`Environment variable ${name} is not set`);
      return value;
    });
}

export async function executeDiscovery(plan: DiscoveryPlan, options: ExecuteDiscoveryOptions = {}): Promise<Omit<DiscoveryResult, 'configured' | 'fresh'>> {
  const headers: Record<string, string> = {};
  for (const [name, template] of Object.entries(plan.headers)) headers[name] = await resolveTemplate(template, options);
  for (const auth of plan.authHeaders) {
    const value = await resolveTemplate(auth.template, options);
    headers[auth.header] = `${auth.prefix ?? ''}${value}`;
  }
  const started = Date.now();
  const response = await (options.fetchImpl ?? fetch)(plan.url, {
    method: 'GET',
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  const body = await response.text();
  const elapsedMs = Date.now() - started;
  if (!response.ok) {
    throw new DiscoveryError(`Endpoint returned HTTP ${response.status}`, plan.url, response.status, body.slice(0, 2000));
  }
  let payload: unknown;
  try { payload = JSON.parse(body); }
  catch { throw new DiscoveryError('Endpoint did not return JSON', plan.url, response.status, body.slice(0, 2000)); }
  let models: DiscoveredModel[];
  try { models = normalizeDiscoveredModels(payload); }
  catch (error) { throw new DiscoveryError(errorMessage(error), plan.url, response.status, body.slice(0, 2000)); }
  return { url: plan.url, status: response.status, elapsedMs, models };
}

export async function fetchProviderModels(provider: ProviderDefinition, options: FetchModelsOptions = {}): Promise<DiscoveryResult> {
  const plan = planDiscovery(provider, options.modelsUrl);
  const result = await executeDiscovery(plan, options);
  const configuredIds = new Set((provider.models ?? []).map(model => model.id));
  const configured = result.models.filter(model => configuredIds.has(model.id)).length;
  return { ...result, configured, fresh: result.models.length - configured };
}

function pathValue(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function firstNumber(value: unknown, paths: string[]): number | undefined {
  return positive(...paths.map(path => pathValue(value, path)));
}

function firstBoolean(value: unknown, paths: string[]): boolean | undefined {
  for (const path of paths) {
    const current = pathValue(value, path);
    if (typeof current === 'boolean') return current;
  }
  return undefined;
}

function arrayIncludes(value: unknown, path: string, expected: string): boolean {
  const current = pathValue(value, path);
  return Array.isArray(current) && current.some(item => typeof item === 'string' && item.toLowerCase() === expected);
}

function stringIncludes(value: unknown, path: string, expected: string): boolean {
  const current = pathValue(value, path);
  return typeof current === 'string' && current.toLowerCase().includes(expected);
}

function inferInput(value: unknown): InputModality[] | undefined {
  const image = arrayIncludes(value, 'architecture.input_modalities', 'image')
    || arrayIncludes(value, 'input_modalities', 'image')
    || stringIncludes(value, 'architecture.modality', 'image')
    || firstBoolean(value, ['supports_vision', 'capabilities.vision', 'capabilities.image_input']) === true;
  return image ? ['text', 'image'] : undefined;
}

function inferReasoning(value: unknown): boolean | undefined {
  const direct = firstBoolean(value, ['capabilities.reasoning', 'supports_reasoning', 'reasoning']);
  if (direct !== undefined) return direct;
  const parameters = pathValue(value, 'supported_parameters');
  if (Array.isArray(parameters)) return parameters.some(item => typeof item === 'string' && item.toLowerCase() === 'reasoning');
  return undefined;
}

/** Accept OpenAI, Anthropic, Google, and common relay response shapes. */
export function normalizeDiscoveredModels(payload: unknown): DiscoveredModel[] {
  const items = Array.isArray(payload) ? payload
    : isObject(payload) && Array.isArray(payload.data) ? payload.data
      : isObject(payload) && Array.isArray(payload.models) ? payload.models
        : isObject(payload) && isObject(payload.data) && Array.isArray(payload.data.models) ? payload.data.models
          : undefined;
  if (!items) throw new Error('Endpoint response has no data or models array.');
  const models = new Map<string, DiscoveredModel>();
  for (const item of items) {
    const rawId = typeof item === 'string' ? item
      : isObject(item) ? firstString(item.id, item.model, item.name) : undefined;
    if (!rawId) continue;
    const raw = rawId.trim().replace(/^models\//, '');
    if (!raw || /[\0\r\n]/.test(raw)) continue;
    const display = isObject(item) ? firstString(item.display_name, item.displayName, item.name) : undefined;
    const name = display && display !== raw && display !== `models/${raw}`
      ? display.replace(/[\r\n\t]/g, ' ').trim() || undefined : undefined;
    const contextWindow = isObject(item)
      ? firstNumber(item, ['context_length', 'context_window', 'max_context_length', 'max_input_tokens', 'inputTokenLimit', 'top_provider.context_length', 'limits.context_window', 'meta.context_length'])
      : undefined;
    const maxTokens = isObject(item)
      ? firstNumber(item, ['max_completion_tokens', 'max_output_tokens', 'outputTokenLimit', 'maxOutputTokens', 'top_provider.max_completion_tokens', 'limits.max_output_tokens', 'meta.max_tokens'])
      : undefined;
    const reasoning = isObject(item) ? inferReasoning(item) : undefined;
    const input = isObject(item) ? inferInput(item) : undefined;
    const current = models.get(raw);
    const next: DiscoveredModel = {
      id: raw,
      ...(name ?? current?.name ? { name: name ?? current?.name } : {}),
      ...(contextWindow ?? current?.contextWindow ? { contextWindow: contextWindow ?? current?.contextWindow } : {}),
      ...(maxTokens ?? current?.maxTokens ? { maxTokens: maxTokens ?? current?.maxTokens } : {}),
      ...(reasoning !== undefined ? { reasoning } : current?.reasoning !== undefined ? { reasoning: current.reasoning } : {}),
      ...(input ? { input } : current?.input ? { input: current.input } : {}),
    };
    models.set(raw, next);
  }
  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Auto-fill the same values Pi uses when a field is omitted. */
export function starterModel(discovered: DiscoveredModel): ModelDefinition {
  const contextWindow = discovered.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const inferredMax = discovered.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxTokens = Math.min(inferredMax, contextWindow);
  return {
    id: discovered.id,
    ...(discovered.name ? { name: discovered.name } : {}),
    reasoning: discovered.reasoning ?? false,
    input: discovered.input?.length ? [...new Set(discovered.input)] : ['text'],
    contextWindow,
    maxTokens: maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
    cost: { ...DEFAULT_COST },
  };
}

export function newDiscoveredModels(provider: ProviderDefinition, selected: DiscoveredModel[]): ModelDefinition[] {
  const existing = new Set((provider.models ?? []).map(model => model.id));
  const added: ModelDefinition[] = [];
  for (const model of selected) {
    if (existing.has(model.id)) continue;
    existing.add(model.id);
    added.push(starterModel(model));
  }
  return added;
}

export function describeDiscoveryPlan(plan: DiscoveryPlan): string {
  return [
    `GET ${plan.url}`,
    `Auth: ${plan.authLabel}`,
    ...(Object.keys(plan.headers).length ? [`Headers: ${Object.keys(plan.headers).join(', ')}`] : []),
    ...(plan.commands.length ? ['Commands run locally to resolve values:', ...plan.commands.map(item => `  ${item.label}: ${item.command}`)] : []),
    'Uses the Pi process network and HTTP proxy settings. No files change until you confirm an add.',
  ].join('\n');
}
