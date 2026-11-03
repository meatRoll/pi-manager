import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { errorCode } from './errors.js';
import { MANAGER_HOME } from './storage.js';

/** Pi reads models.json from its agent directory, not from a manager profile. */
export function activeAgentDir(): string {
  const value = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  return resolve(expanded);
}
export const modelsPath = (agentDir = activeAgentDir()) => join(agentDir, 'models.json');
export const settingsPath = (agentDir = activeAgentDir()) => join(agentDir, 'settings.json');

export type JsonObject = Record<string, unknown>;
export type InputModality = 'text' | 'image';
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const MODEL_INPUT_MODALITIES: readonly InputModality[] = ['text', 'image'];
export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 16384;
export const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

export interface ModelCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tiers?: unknown[];
  [key: string]: unknown;
}

export interface ModelDefinition {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: InputModality[];
  inputLimits?: JsonObject;
  cost?: ModelCost;
  promptCache?: JsonObject;
  contextWindow?: number;
  maxTokens?: number;
  samplingParams?: JsonObject;
  samplingParamsByThinkingLevel?: JsonObject;
  headers?: JsonObject;
  compat?: JsonObject;
  [key: string]: unknown;
}

export interface ModelOverride {
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: InputModality[];
  inputLimits?: JsonObject;
  cost?: ModelCost;
  promptCache?: JsonObject;
  contextWindow?: number;
  maxTokens?: number;
  samplingParams?: JsonObject;
  samplingParamsByThinkingLevel?: JsonObject;
  headers?: JsonObject;
  compat?: JsonObject;
  [key: string]: unknown;
}

export interface ProviderDefinition {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  oauth?: 'radius';
  headers?: JsonObject;
  compat?: JsonObject;
  authHeader?: boolean;
  models?: ModelDefinition[];
  modelOverrides?: Record<string, ModelOverride>;
  [key: string]: unknown;
}

export interface ModelsConfig {
  $schema?: string;
  providers?: Record<string, ProviderDefinition>;
  [key: string]: unknown;
}

export interface SettingsConfig {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  enabledModels?: string[];
  [key: string]: unknown;
}

export interface ConfigDocument<T> {
  path: string;
  raw: string;
  exists: boolean;
  revision?: string;
  value?: T;
  error?: string;
}

export interface ModelDefaults {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  enabledModels?: string[];
}

export interface WriteOptions {
  agentDir?: string;
  expectedRevision?: string;
  backupDir?: string;
  keepBackups?: number;
}

export interface WriteResult {
  path: string;
  revision: string;
  backup?: string;
}

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const stripBom = (text: string) => text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
/** Pi accepts line comments and trailing commas in its JSON config files. */
const stripJsonExtras = (text: string) => text
  .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, match => match[0] === '"' ? match : '')
  .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : ''));
export function parseJsonConfig(text: string): unknown {
  return JSON.parse(stripJsonExtras(stripBom(text)));
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isPositiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isNonNegativeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const hasControl = (value: string) => /[\0\r\n]/.test(value);

function validHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch { return false; }
}

export function validProviderId(id: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new Error('Provider id must use 1–128 letters, numbers, dots, underscores or hyphens, and start with a letter or number.');
  }
  return id;
}

export function validModelId(id: string) {
  if (typeof id !== 'string' || !id.trim() || hasControl(id)) throw new Error('Model id must be a non-empty string without newlines.');
  return id;
}

function checkString(owner: JsonObject, key: string, path: string, errors: string[], options: { nonEmpty?: boolean; url?: boolean } = {}) {
  const value = owner[key];
  if (value === undefined) return;
  if (typeof value !== 'string') { errors.push(`${path}.${key} must be a string`); return; }
  if (options.nonEmpty && !value.trim()) errors.push(`${path}.${key} must not be empty`);
  if (hasControl(value)) errors.push(`${path}.${key} must not contain control characters`);
  if (options.url && value.trim() && !validHttpUrl(value)) errors.push(`${path}.${key} must be an http(s) URL`);
}

function checkBoolean(owner: JsonObject, key: string, path: string, errors: string[]) {
  if (owner[key] !== undefined && typeof owner[key] !== 'boolean') errors.push(`${path}.${key} must be true or false`);
}

function checkObject(owner: JsonObject, key: string, path: string, errors: string[]) {
  if (owner[key] !== undefined && !isObject(owner[key])) errors.push(`${path}.${key} must be an object`);
}

function checkPositiveInteger(owner: JsonObject, key: string, path: string, errors: string[]) {
  if (owner[key] !== undefined && !isPositiveInteger(owner[key])) errors.push(`${path}.${key} must be a positive integer`);
}

function checkCost(owner: JsonObject, path: string, errors: string[], partial: boolean) {
  const value = owner.cost;
  if (value === undefined) return;
  if (!isObject(value)) { errors.push(`${path}.cost must be an object`); return; }
  const rates = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
  for (const key of rates) {
    if (value[key] === undefined) {
      if (!partial) errors.push(`${path}.cost.${key} is required`);
    } else if (!isNonNegativeNumber(value[key])) {
      errors.push(`${path}.cost.${key} must be a non-negative number`);
    }
  }
  if (value.tiers !== undefined) {
    if (!Array.isArray(value.tiers)) errors.push(`${path}.cost.tiers must be an array`);
    else value.tiers.forEach((tier, index) => {
      const tierPath = `${path}.cost.tiers[${index}]`;
      if (!isObject(tier)) { errors.push(`${tierPath} must be an object`); return; }
      for (const key of [...rates, 'inputTokensAbove']) {
        if (!isNonNegativeNumber(tier[key])) errors.push(`${tierPath}.${key} must be a non-negative number`);
      }
    });
  }
}

function checkModel(owner: JsonObject, path: string, errors: string[], options: { override?: boolean } = {}) {
  if (!options.override) {
    if (!hasText(owner.id)) errors.push(`${path}.id must be a non-empty string`);
    else if (hasControl(owner.id)) errors.push(`${path}.id must not contain control characters`);
    checkString(owner, 'api', path, errors, { nonEmpty: true });
    checkString(owner, 'baseUrl', path, errors, { nonEmpty: true, url: true });
  }
  checkString(owner, 'name', path, errors, { nonEmpty: true });
  checkBoolean(owner, 'reasoning', path, errors);
  checkPositiveInteger(owner, 'contextWindow', path, errors);
  checkPositiveInteger(owner, 'maxTokens', path, errors);
  if (owner.input !== undefined) {
    if (!Array.isArray(owner.input) || !owner.input.length) errors.push(`${path}.input must be a non-empty array`);
    else owner.input.forEach((item, index) => {
      if (item !== 'text' && item !== 'image') errors.push(`${path}.input[${index}] must be "text" or "image"`);
    });
  }
  if (owner.thinkingLevelMap !== undefined) {
    if (!isObject(owner.thinkingLevelMap)) errors.push(`${path}.thinkingLevelMap must be an object`);
    else for (const [level, mapped] of Object.entries(owner.thinkingLevelMap)) {
      if (mapped !== null && typeof mapped !== 'string') errors.push(`${path}.thinkingLevelMap.${level} must be a string or null`);
    }
  }
  if (owner.headers !== undefined) {
    if (!isObject(owner.headers)) errors.push(`${path}.headers must be an object`);
    else for (const [header, value] of Object.entries(owner.headers)) {
      if (typeof value !== 'string') errors.push(`${path}.headers.${header} must be a string`);
    }
  }
  for (const key of ['inputLimits', 'promptCache', 'samplingParams', 'samplingParamsByThinkingLevel', 'compat']) {
    checkObject(owner, key, path, errors);
  }
  checkCost(owner, path, errors, options.override === true);
}

export function validateModelsValue(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ['models.json must contain a JSON object'];
  checkString(value, '$schema', '$', errors);
  if (value.providers === undefined) return errors;
  if (!isObject(value.providers)) return [...errors, '$.providers must be an object'];
  for (const [providerId, rawProvider] of Object.entries(value.providers)) {
    const path = `$.providers.${providerId}`;
    try { validProviderId(providerId); }
    catch (error) { errors.push(`${path}: ${(error as Error).message}`); }
    if (!isObject(rawProvider)) { errors.push(`${path} must be an object`); continue; }
    checkString(rawProvider, 'name', path, errors, { nonEmpty: true });
    checkString(rawProvider, 'baseUrl', path, errors, { nonEmpty: true, url: true });
    checkString(rawProvider, 'apiKey', path, errors);
    checkString(rawProvider, 'api', path, errors, { nonEmpty: true });
    checkString(rawProvider, 'oauth', path, errors, { nonEmpty: true });
    if (rawProvider.oauth !== undefined && rawProvider.oauth !== 'radius') errors.push(`${path}.oauth must be "radius"`);
    if (rawProvider.oauth && !hasText(rawProvider.baseUrl)) errors.push(`${path}.baseUrl is required when oauth is set`);
    checkBoolean(rawProvider, 'authHeader', path, errors);
    if (rawProvider.headers !== undefined) {
      if (!isObject(rawProvider.headers)) errors.push(`${path}.headers must be an object`);
      else for (const [header, value] of Object.entries(rawProvider.headers)) {
        if (typeof value !== 'string') errors.push(`${path}.headers.${header} must be a string`);
      }
    }
    checkObject(rawProvider, 'compat', path, errors);

    if (rawProvider.models !== undefined) {
      if (!Array.isArray(rawProvider.models)) errors.push(`${path}.models must be an array`);
      else {
        const seen = new Set<string>();
        rawProvider.models.forEach((model, index) => {
          const modelPath = `${path}.models[${index}]`;
          if (!isObject(model)) { errors.push(`${modelPath} must be an object`); return; }
          checkModel(model, modelPath, errors);
          if (hasText(model.id)) {
            if (seen.has(model.id)) errors.push(`${modelPath}.id duplicates another model in this provider`);
            seen.add(model.id);
          }
        });
      }
    }
    if (rawProvider.modelOverrides !== undefined) {
      if (!isObject(rawProvider.modelOverrides)) errors.push(`${path}.modelOverrides must be an object`);
      else for (const [modelId, override] of Object.entries(rawProvider.modelOverrides)) {
        const overridePath = `${path}.modelOverrides.${modelId}`;
        if (!modelId.trim() || hasControl(modelId)) errors.push(`${overridePath}: model id must be non-empty and must not contain newlines`);
        if (!isObject(override)) { errors.push(`${overridePath} must be an object`); continue; }
        checkModel(override, overridePath, errors, { override: true });
      }
    }

    const hasOverrides = isObject(rawProvider.modelOverrides) && Object.keys(rawProvider.modelOverrides).length > 0;
    const hasModels = Array.isArray(rawProvider.models) && rawProvider.models.length > 0;
    if (!hasModels && !hasText(rawProvider.baseUrl) && !rawProvider.headers && !rawProvider.compat && !hasOverrides
      && !hasText(rawProvider.apiKey) && !rawProvider.oauth && rawProvider.authHeader === undefined) {
      errors.push(`${path} must specify baseUrl, headers, compat, modelOverrides, models, apiKey, oauth, or authHeader`);
    }
  }
  return errors;
}

export function validateSettingsValue(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ['settings.json must contain a JSON object'];
  for (const key of ['defaultProvider', 'defaultModel']) {
    const current = value[key];
    if (current !== undefined && (typeof current !== 'string' || !current.trim())) errors.push(`${key} must be a non-empty string`);
  }
  if (value.defaultThinkingLevel !== undefined && !THINKING_LEVELS.includes(value.defaultThinkingLevel as ThinkingLevel)) {
    errors.push(`defaultThinkingLevel must be one of ${THINKING_LEVELS.join(', ')}`);
  }
  if (value.enabledModels !== undefined) {
    if (!Array.isArray(value.enabledModels)) errors.push('enabledModels must be an array');
    else value.enabledModels.forEach((pattern, index) => {
      if (typeof pattern !== 'string' || !pattern.trim()) errors.push(`enabledModels[${index}] must be a non-empty string`);
      else if (hasControl(pattern)) errors.push(`enabledModels[${index}] must not contain control characters`);
    });
  }
  return errors;
}

async function readDocument<T>(path: string, validate: (value: unknown) => string[], fallback: T): Promise<ConfigDocument<T>> {
  let raw: string;
  try { raw = stripBom(await readFile(path, 'utf8')); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return { path, raw: '', exists: false, value: fallback };
    throw error;
  }
  const revision = hash(raw);
  let parsed: unknown;
  try { parsed = parseJsonConfig(raw); }
  catch (error) { return { path, raw, exists: true, revision, error: `Invalid JSON: ${(error as Error).message}` }; }
  const errors = validate(parsed);
  if (errors.length) return { path, raw, exists: true, revision, error: errors.join('\n') };
  return { path, raw, exists: true, revision, value: parsed as T };
}

export const readModels = (agentDir = activeAgentDir()) =>
  readDocument<ModelsConfig>(modelsPath(agentDir), validateModelsValue, { providers: {} });
export const readSettings = (agentDir = activeAgentDir()) =>
  readDocument<SettingsConfig>(settingsPath(agentDir), validateSettingsValue, {});

async function backupCurrent(path: string, raw: string, backupDir: string, keep: number) {
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const name = basename(path);
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const target = join(backupDir, `${name}.${stamp}-${randomUUID().slice(0, 8)}.bak`);
  await writeFile(target, raw, { mode: 0o600 });
  const backups = (await readdir(backupDir))
    .filter(entry => entry.startsWith(`${name}.`) && entry.endsWith('.bak'))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) await rm(join(backupDir, old), { force: true });
  return target;
}

async function writeDocument<T>(path: string, value: T, options: WriteOptions): Promise<WriteResult> {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  let current: string | undefined;
  try { current = stripBom(await readFile(path, 'utf8')); }
  catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  const currentRevision = current === undefined ? undefined : hash(current);
  if (currentRevision !== options.expectedRevision) {
    throw new Error(`${basename(path)} changed outside pi-manager. Reload and retry; the file was not written.`);
  }
  try {
    const target = await lstat(path);
    if (target.isSymbolicLink()) throw new Error(`Refusing to replace a symlink: ${path}`);
  } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  const backup = current === undefined ? undefined
    : await backupCurrent(path, current, options.backupDir ?? join(MANAGER_HOME, 'backups', 'agent'), options.keepBackups ?? 10);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
  return { path, revision: hash(text), ...(backup ? { backup } : {}) };
}

export async function writeModels(config: ModelsConfig, options: WriteOptions = {}): Promise<WriteResult> {
  const errors = validateModelsValue(config);
  if (errors.length) throw new Error(`Invalid models.json:\n${errors.join('\n')}`);
  return writeDocument(modelsPath(options.agentDir), config, options);
}

export async function writeSettings(settings: SettingsConfig, options: WriteOptions = {}): Promise<WriteResult> {
  const errors = validateSettingsValue(settings);
  if (errors.length) throw new Error(`Invalid settings.json:\n${errors.join('\n')}`);
  return writeDocument(settingsPath(options.agentDir), settings, options);
}

export function providersOf(config: ModelsConfig): Array<[string, ProviderDefinition]> {
  return Object.entries(config.providers ?? {});
}

export function providerOf(config: ModelsConfig, providerId: string): ProviderDefinition | undefined {
  return config.providers?.[providerId];
}

function requireProvider(config: ModelsConfig, providerId: string): ProviderDefinition {
  const provider = providerOf(config, providerId);
  if (!provider) throw new Error(`Provider not found: ${providerId}`);
  return provider;
}

/** Pi rejects a provider entry with no usable configuration. Keep this in sync
 * with applyModelsJson() so deleting a model or override cannot leave one behind.
 */
export function providerHasContent(provider: ProviderDefinition): boolean {
  return Boolean(provider.baseUrl || provider.headers || provider.compat || provider.apiKey || provider.oauth
    || provider.authHeader !== undefined
    || (provider.models && provider.models.length)
    || (provider.modelOverrides && Object.keys(provider.modelOverrides).length));
}

function dropEmptyProvider(config: ModelsConfig, providerId: string) {
  const provider = providerOf(config, providerId);
  if (provider && !providerHasContent(provider)) delete config.providers![providerId];
}

export function setProvider(config: ModelsConfig, providerId: string, provider: ProviderDefinition) {
  validProviderId(providerId);
  (config.providers ??= {})[providerId] = provider;
}

export function removeProvider(config: ModelsConfig, providerId: string) {
  if (!config.providers?.[providerId]) throw new Error(`Provider not found: ${providerId}`);
  delete config.providers[providerId];
}

export function setModel(config: ModelsConfig, providerId: string, model: ModelDefinition) {
  validModelId(model.id);
  const provider = requireProvider(config, providerId);
  const models = provider.models ??= [];
  const index = models.findIndex(item => item.id === model.id);
  if (index >= 0) models[index] = model;
  else models.push(model);
}

export function removeModel(config: ModelsConfig, providerId: string, modelId: string) {
  const provider = requireProvider(config, providerId);
  const models = provider.models ?? [];
  const index = models.findIndex(item => item.id === modelId);
  if (index < 0) throw new Error(`Model not found: ${providerId}/${modelId}`);
  models.splice(index, 1);
  if (!models.length) delete provider.models;
  dropEmptyProvider(config, providerId);
}

export function setOverride(config: ModelsConfig, providerId: string, modelId: string, override: ModelOverride) {
  validProviderId(providerId);
  validModelId(modelId);
  const provider = (config.providers ??= {})[providerId] ??= {};
  provider.modelOverrides ??= {};
  provider.modelOverrides[modelId] = override;
}

export function removeOverride(config: ModelsConfig, providerId: string, modelId: string) {
  const provider = requireProvider(config, providerId);
  if (!provider.modelOverrides?.[modelId]) throw new Error(`Model override not found: ${providerId}/${modelId}`);
  delete provider.modelOverrides[modelId];
  if (!Object.keys(provider.modelOverrides).length) delete provider.modelOverrides;
  dropEmptyProvider(config, providerId);
}

export function readModelDefaults(settings: SettingsConfig): ModelDefaults {
  return {
    provider: settings.defaultProvider,
    model: settings.defaultModel,
    thinking: settings.defaultThinkingLevel,
    enabledModels: Array.isArray(settings.enabledModels) ? settings.enabledModels.filter(hasText) : undefined,
  };
}

export interface DefaultSelection {
  provider?: string | null;
  model?: string | null;
  thinking?: ThinkingLevel | null;
}

export function setDefaultSelection(settings: SettingsConfig, selection: DefaultSelection) {
  if (selection.provider !== undefined || selection.model !== undefined) {
    const provider = selection.provider === undefined ? settings.defaultProvider : selection.provider;
    const model = selection.model === undefined ? settings.defaultModel : selection.model;
    if (provider && model) {
      settings.defaultProvider = provider;
      settings.defaultModel = model;
    } else if (!provider && !model) {
      delete settings.defaultProvider;
      delete settings.defaultModel;
    } else {
      throw new Error('Set both the default provider and model, or clear both.');
    }
  }
  if (selection.thinking !== undefined) {
    if (selection.thinking === null) delete settings.defaultThinkingLevel;
    else {
      if (!THINKING_LEVELS.includes(selection.thinking)) throw new Error(`Unknown thinking level: ${selection.thinking}`);
      settings.defaultThinkingLevel = selection.thinking;
    }
  }
}

export function setEnabledPatterns(settings: SettingsConfig, patterns: string[]) {
  const cleaned = [...new Set(patterns.map(pattern => pattern.trim()).filter(Boolean))];
  if (cleaned.length) settings.enabledModels = cleaned;
  else delete settings.enabledModels;
}

export function maskSecret(value: string | undefined | null): string {
  if (!value) return '(none)';
  if (value.startsWith('$')) return value;
  if (value.startsWith('!')) {
    const command = value.slice(1).trim().replace(/[\r\n]/g, ' ');
    return `!${command.length > 28 ? `${command.slice(0, 28)}…` : command}`;
  }
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

export type SecretKind = 'none' | 'literal' | 'env' | 'command';
export function secretKind(value: string | undefined): SecretKind {
  if (!value) return 'none';
  if (value.startsWith('$')) return 'env';
  if (value.startsWith('!')) return 'command';
  return 'literal';
}

export function formatTokens(value: number | undefined): string {
  if (!value) return 'default';
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : Number(millions.toFixed(2))}M`;
  }
  if (value >= 1000) {
    const thousands = value / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : Number(thousands.toFixed(1))}K`;
  }
  return String(value);
}

export function providerDetail(provider: ProviderDefinition): string {
  const models = provider.models?.length ?? 0;
  const overrides = provider.modelOverrides ? Object.keys(provider.modelOverrides).length : 0;
  return [
    `${models} model${models === 1 ? '' : 's'}`,
    provider.api || 'built-in api',
    `key ${maskSecret(provider.apiKey)}`,
    ...(overrides ? [`${overrides} override${overrides === 1 ? '' : 's'}`] : []),
  ].join(' · ');
}

export function modelDetail(model: ModelDefinition): string {
  const input = model.input?.includes('image') ? 'text+image' : 'text';
  return [
    `${formatTokens(model.contextWindow)} ctx`,
    `${formatTokens(model.maxTokens)} out`,
    model.reasoning ? 'reasoning' : 'no reasoning',
    input,
  ].join(' · ');
}

export function overrideDetail(override: ModelOverride): string {
  const keys = Object.keys(override).filter(key => override[key] !== undefined);
  return keys.length ? keys.join(', ') : 'no fields';
}
