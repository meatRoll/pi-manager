import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { errorCode } from './errors.js';
import { MANAGER_HOME } from './storage.js';
/** Pi reads models.json from its agent directory, not from a manager profile. */
export function activeAgentDir() {
    const value = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
    const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
    return resolve(expanded);
}
export const modelsPath = (agentDir = activeAgentDir()) => join(agentDir, 'models.json');
export const settingsPath = (agentDir = activeAgentDir()) => join(agentDir, 'settings.json');
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const MODEL_INPUT_MODALITIES = ['text', 'image'];
export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 16384;
export const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const stripBom = (text) => text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
/** Pi accepts line comments and trailing commas in its JSON config files. */
const stripJsonExtras = (text) => text
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, match => match[0] === '"' ? match : '')
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ''));
export function parseJsonConfig(text) {
    return JSON.parse(stripJsonExtras(stripBom(text)));
}
const hash = (text) => createHash('sha256').update(text).digest('hex');
const hasText = (value) => typeof value === 'string' && value.trim().length > 0;
const isPositiveInteger = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isNonNegativeNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const hasControl = (value) => /[\0\r\n]/.test(value);
function validHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    }
    catch {
        return false;
    }
}
export function validProviderId(id) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
        throw new Error('Provider id must use 1–128 letters, numbers, dots, underscores or hyphens, and start with a letter or number.');
    }
    return id;
}
export function validModelId(id) {
    if (typeof id !== 'string' || !id.trim() || hasControl(id))
        throw new Error('Model id must be a non-empty string without newlines.');
    return id;
}
function checkString(owner, key, path, errors, options = {}) {
    const value = owner[key];
    if (value === undefined)
        return;
    if (typeof value !== 'string') {
        errors.push(`${path}.${key} must be a string`);
        return;
    }
    if (options.nonEmpty && !value.trim())
        errors.push(`${path}.${key} must not be empty`);
    if (hasControl(value))
        errors.push(`${path}.${key} must not contain control characters`);
    if (options.url && value.trim() && !validHttpUrl(value))
        errors.push(`${path}.${key} must be an http(s) URL`);
}
function checkBoolean(owner, key, path, errors) {
    if (owner[key] !== undefined && typeof owner[key] !== 'boolean')
        errors.push(`${path}.${key} must be true or false`);
}
function checkObject(owner, key, path, errors) {
    if (owner[key] !== undefined && !isObject(owner[key]))
        errors.push(`${path}.${key} must be an object`);
}
function checkPositiveInteger(owner, key, path, errors) {
    if (owner[key] !== undefined && !isPositiveInteger(owner[key]))
        errors.push(`${path}.${key} must be a positive integer`);
}
function checkCost(owner, path, errors, partial) {
    const value = owner.cost;
    if (value === undefined)
        return;
    if (!isObject(value)) {
        errors.push(`${path}.cost must be an object`);
        return;
    }
    const rates = ['input', 'output', 'cacheRead', 'cacheWrite'];
    for (const key of rates) {
        if (value[key] === undefined) {
            if (!partial)
                errors.push(`${path}.cost.${key} is required`);
        }
        else if (!isNonNegativeNumber(value[key])) {
            errors.push(`${path}.cost.${key} must be a non-negative number`);
        }
    }
    if (value.tiers !== undefined) {
        if (!Array.isArray(value.tiers))
            errors.push(`${path}.cost.tiers must be an array`);
        else
            value.tiers.forEach((tier, index) => {
                const tierPath = `${path}.cost.tiers[${index}]`;
                if (!isObject(tier)) {
                    errors.push(`${tierPath} must be an object`);
                    return;
                }
                for (const key of [...rates, 'inputTokensAbove']) {
                    if (!isNonNegativeNumber(tier[key]))
                        errors.push(`${tierPath}.${key} must be a non-negative number`);
                }
            });
    }
}
function checkModel(owner, path, errors, options = {}) {
    if (!options.override) {
        if (!hasText(owner.id))
            errors.push(`${path}.id must be a non-empty string`);
        else if (hasControl(owner.id))
            errors.push(`${path}.id must not contain control characters`);
        checkString(owner, 'api', path, errors, { nonEmpty: true });
        checkString(owner, 'baseUrl', path, errors, { nonEmpty: true, url: true });
    }
    checkString(owner, 'name', path, errors, { nonEmpty: true });
    checkBoolean(owner, 'reasoning', path, errors);
    checkPositiveInteger(owner, 'contextWindow', path, errors);
    checkPositiveInteger(owner, 'maxTokens', path, errors);
    if (owner.input !== undefined) {
        if (!Array.isArray(owner.input) || !owner.input.length)
            errors.push(`${path}.input must be a non-empty array`);
        else
            owner.input.forEach((item, index) => {
                if (item !== 'text' && item !== 'image')
                    errors.push(`${path}.input[${index}] must be "text" or "image"`);
            });
    }
    if (owner.thinkingLevelMap !== undefined) {
        if (!isObject(owner.thinkingLevelMap))
            errors.push(`${path}.thinkingLevelMap must be an object`);
        else
            for (const [level, mapped] of Object.entries(owner.thinkingLevelMap)) {
                if (mapped !== null && typeof mapped !== 'string')
                    errors.push(`${path}.thinkingLevelMap.${level} must be a string or null`);
            }
    }
    if (owner.headers !== undefined) {
        if (!isObject(owner.headers))
            errors.push(`${path}.headers must be an object`);
        else
            for (const [header, value] of Object.entries(owner.headers)) {
                if (typeof value !== 'string')
                    errors.push(`${path}.headers.${header} must be a string`);
            }
    }
    for (const key of ['inputLimits', 'promptCache', 'samplingParams', 'samplingParamsByThinkingLevel', 'compat']) {
        checkObject(owner, key, path, errors);
    }
    checkCost(owner, path, errors, options.override === true);
}
export function validateModelsValue(value) {
    const errors = [];
    if (!isObject(value))
        return ['models.json must contain a JSON object'];
    checkString(value, '$schema', '$', errors);
    if (value.providers === undefined)
        return errors;
    if (!isObject(value.providers))
        return [...errors, '$.providers must be an object'];
    for (const [providerId, rawProvider] of Object.entries(value.providers)) {
        const path = `$.providers.${providerId}`;
        try {
            validProviderId(providerId);
        }
        catch (error) {
            errors.push(`${path}: ${error.message}`);
        }
        if (!isObject(rawProvider)) {
            errors.push(`${path} must be an object`);
            continue;
        }
        checkString(rawProvider, 'name', path, errors, { nonEmpty: true });
        checkString(rawProvider, 'baseUrl', path, errors, { nonEmpty: true, url: true });
        checkString(rawProvider, 'apiKey', path, errors);
        checkString(rawProvider, 'api', path, errors, { nonEmpty: true });
        checkString(rawProvider, 'oauth', path, errors, { nonEmpty: true });
        if (rawProvider.oauth !== undefined && rawProvider.oauth !== 'radius')
            errors.push(`${path}.oauth must be "radius"`);
        if (rawProvider.oauth && !hasText(rawProvider.baseUrl))
            errors.push(`${path}.baseUrl is required when oauth is set`);
        checkBoolean(rawProvider, 'authHeader', path, errors);
        if (rawProvider.headers !== undefined) {
            if (!isObject(rawProvider.headers))
                errors.push(`${path}.headers must be an object`);
            else
                for (const [header, value] of Object.entries(rawProvider.headers)) {
                    if (typeof value !== 'string')
                        errors.push(`${path}.headers.${header} must be a string`);
                }
        }
        checkObject(rawProvider, 'compat', path, errors);
        if (rawProvider.models !== undefined) {
            if (!Array.isArray(rawProvider.models))
                errors.push(`${path}.models must be an array`);
            else {
                const seen = new Set();
                rawProvider.models.forEach((model, index) => {
                    const modelPath = `${path}.models[${index}]`;
                    if (!isObject(model)) {
                        errors.push(`${modelPath} must be an object`);
                        return;
                    }
                    checkModel(model, modelPath, errors);
                    if (hasText(model.id)) {
                        if (seen.has(model.id))
                            errors.push(`${modelPath}.id duplicates another model in this provider`);
                        seen.add(model.id);
                    }
                });
            }
        }
        if (rawProvider.modelOverrides !== undefined) {
            if (!isObject(rawProvider.modelOverrides))
                errors.push(`${path}.modelOverrides must be an object`);
            else
                for (const [modelId, override] of Object.entries(rawProvider.modelOverrides)) {
                    const overridePath = `${path}.modelOverrides.${modelId}`;
                    if (!modelId.trim() || hasControl(modelId))
                        errors.push(`${overridePath}: model id must be non-empty and must not contain newlines`);
                    if (!isObject(override)) {
                        errors.push(`${overridePath} must be an object`);
                        continue;
                    }
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
export function validateSettingsValue(value) {
    const errors = [];
    if (!isObject(value))
        return ['settings.json must contain a JSON object'];
    for (const key of ['defaultProvider', 'defaultModel']) {
        const current = value[key];
        if (current !== undefined && (typeof current !== 'string' || !current.trim()))
            errors.push(`${key} must be a non-empty string`);
    }
    if (value.defaultThinkingLevel !== undefined && !THINKING_LEVELS.includes(value.defaultThinkingLevel)) {
        errors.push(`defaultThinkingLevel must be one of ${THINKING_LEVELS.join(', ')}`);
    }
    if (value.enabledModels !== undefined) {
        if (!Array.isArray(value.enabledModels))
            errors.push('enabledModels must be an array');
        else
            value.enabledModels.forEach((pattern, index) => {
                if (typeof pattern !== 'string' || !pattern.trim())
                    errors.push(`enabledModels[${index}] must be a non-empty string`);
                else if (hasControl(pattern))
                    errors.push(`enabledModels[${index}] must not contain control characters`);
            });
    }
    return errors;
}
async function readDocument(path, validate, fallback) {
    let raw;
    try {
        raw = stripBom(await readFile(path, 'utf8'));
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return { path, raw: '', exists: false, value: fallback };
        throw error;
    }
    const revision = hash(raw);
    let parsed;
    try {
        parsed = parseJsonConfig(raw);
    }
    catch (error) {
        return { path, raw, exists: true, revision, error: `Invalid JSON: ${error.message}` };
    }
    const errors = validate(parsed);
    if (errors.length)
        return { path, raw, exists: true, revision, error: errors.join('\n') };
    return { path, raw, exists: true, revision, value: parsed };
}
export const readModels = (agentDir = activeAgentDir()) => readDocument(modelsPath(agentDir), validateModelsValue, { providers: {} });
export const readSettings = (agentDir = activeAgentDir()) => readDocument(settingsPath(agentDir), validateSettingsValue, {});
async function backupCurrent(path, raw, backupDir, keep) {
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const name = basename(path);
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    const target = join(backupDir, `${name}.${stamp}-${randomUUID().slice(0, 8)}.bak`);
    await writeFile(target, raw, { mode: 0o600 });
    const backups = (await readdir(backupDir))
        .filter(entry => entry.startsWith(`${name}.`) && entry.endsWith('.bak'))
        .sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - keep)))
        await rm(join(backupDir, old), { force: true });
    return target;
}
async function writeDocument(path, value, options) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    let current;
    try {
        current = stripBom(await readFile(path, 'utf8'));
    }
    catch (error) {
        if (errorCode(error) !== 'ENOENT')
            throw error;
    }
    const currentRevision = current === undefined ? undefined : hash(current);
    if (currentRevision !== options.expectedRevision) {
        throw new Error(`${basename(path)} changed outside pi-manager. Reload and retry; the file was not written.`);
    }
    try {
        const target = await lstat(path);
        if (target.isSymbolicLink())
            throw new Error(`Refusing to replace a symlink: ${path}`);
    }
    catch (error) {
        if (errorCode(error) !== 'ENOENT')
            throw error;
    }
    const backup = current === undefined ? undefined
        : await backupCurrent(path, current, options.backupDir ?? join(MANAGER_HOME, 'backups', 'agent'), options.keepBackups ?? 10);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
            await handle.writeFile(text, 'utf8');
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(temporary, path);
    }
    finally {
        await rm(temporary, { force: true }).catch(() => { });
    }
    return { path, revision: hash(text), ...(backup ? { backup } : {}) };
}
export async function writeModels(config, options = {}) {
    const errors = validateModelsValue(config);
    if (errors.length)
        throw new Error(`Invalid models.json:\n${errors.join('\n')}`);
    return writeDocument(modelsPath(options.agentDir), config, options);
}
export async function writeSettings(settings, options = {}) {
    const errors = validateSettingsValue(settings);
    if (errors.length)
        throw new Error(`Invalid settings.json:\n${errors.join('\n')}`);
    return writeDocument(settingsPath(options.agentDir), settings, options);
}
export function providersOf(config) {
    return Object.entries(config.providers ?? {});
}
export function providerOf(config, providerId) {
    return config.providers?.[providerId];
}
function requireProvider(config, providerId) {
    const provider = providerOf(config, providerId);
    if (!provider)
        throw new Error(`Provider not found: ${providerId}`);
    return provider;
}
/** Pi rejects a provider entry with no usable configuration. Keep this in sync
 * with applyModelsJson() so deleting a model or override cannot leave one behind.
 */
export function providerHasContent(provider) {
    return Boolean(provider.baseUrl || provider.headers || provider.compat || provider.apiKey || provider.oauth
        || provider.authHeader !== undefined
        || (provider.models && provider.models.length)
        || (provider.modelOverrides && Object.keys(provider.modelOverrides).length));
}
function dropEmptyProvider(config, providerId) {
    const provider = providerOf(config, providerId);
    if (provider && !providerHasContent(provider))
        delete config.providers[providerId];
}
export function setProvider(config, providerId, provider) {
    validProviderId(providerId);
    (config.providers ??= {})[providerId] = provider;
}
export function removeProvider(config, providerId) {
    if (!config.providers?.[providerId])
        throw new Error(`Provider not found: ${providerId}`);
    delete config.providers[providerId];
}
export function setModel(config, providerId, model) {
    validModelId(model.id);
    const provider = requireProvider(config, providerId);
    const models = provider.models ??= [];
    const index = models.findIndex(item => item.id === model.id);
    if (index >= 0)
        models[index] = model;
    else
        models.push(model);
}
export function removeModel(config, providerId, modelId) {
    const provider = requireProvider(config, providerId);
    const models = provider.models ?? [];
    const index = models.findIndex(item => item.id === modelId);
    if (index < 0)
        throw new Error(`Model not found: ${providerId}/${modelId}`);
    models.splice(index, 1);
    if (!models.length)
        delete provider.models;
    dropEmptyProvider(config, providerId);
}
export function setOverride(config, providerId, modelId, override) {
    validProviderId(providerId);
    validModelId(modelId);
    const provider = (config.providers ??= {})[providerId] ??= {};
    provider.modelOverrides ??= {};
    provider.modelOverrides[modelId] = override;
}
export function removeOverride(config, providerId, modelId) {
    const provider = requireProvider(config, providerId);
    if (!provider.modelOverrides?.[modelId])
        throw new Error(`Model override not found: ${providerId}/${modelId}`);
    delete provider.modelOverrides[modelId];
    if (!Object.keys(provider.modelOverrides).length)
        delete provider.modelOverrides;
    dropEmptyProvider(config, providerId);
}
export function readModelDefaults(settings) {
    return {
        provider: settings.defaultProvider,
        model: settings.defaultModel,
        thinking: settings.defaultThinkingLevel,
        enabledModels: Array.isArray(settings.enabledModels) ? settings.enabledModels.filter(hasText) : undefined,
    };
}
export function setDefaultSelection(settings, selection) {
    if (selection.provider !== undefined || selection.model !== undefined) {
        const provider = selection.provider === undefined ? settings.defaultProvider : selection.provider;
        const model = selection.model === undefined ? settings.defaultModel : selection.model;
        if (provider && model) {
            settings.defaultProvider = provider;
            settings.defaultModel = model;
        }
        else if (!provider && !model) {
            delete settings.defaultProvider;
            delete settings.defaultModel;
        }
        else {
            throw new Error('Set both the default provider and model, or clear both.');
        }
    }
    if (selection.thinking !== undefined) {
        if (selection.thinking === null)
            delete settings.defaultThinkingLevel;
        else {
            if (!THINKING_LEVELS.includes(selection.thinking))
                throw new Error(`Unknown thinking level: ${selection.thinking}`);
            settings.defaultThinkingLevel = selection.thinking;
        }
    }
}
export function setEnabledPatterns(settings, patterns) {
    const cleaned = [...new Set(patterns.map(pattern => pattern.trim()).filter(Boolean))];
    if (cleaned.length)
        settings.enabledModels = cleaned;
    else
        delete settings.enabledModels;
}
export function maskSecret(value) {
    if (!value)
        return '(none)';
    if (value.startsWith('$'))
        return value;
    if (value.startsWith('!')) {
        const command = value.slice(1).trim().replace(/[\r\n]/g, ' ');
        return `!${command.length > 28 ? `${command.slice(0, 28)}…` : command}`;
    }
    if (value.length <= 8)
        return '••••';
    return `${value.slice(0, 4)}…${value.slice(-2)}`;
}
export function secretKind(value) {
    if (!value)
        return 'none';
    if (value.startsWith('$'))
        return 'env';
    if (value.startsWith('!'))
        return 'command';
    return 'literal';
}
export function formatTokens(value) {
    if (!value)
        return 'default';
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
export function providerDetail(provider) {
    const models = provider.models?.length ?? 0;
    const overrides = provider.modelOverrides ? Object.keys(provider.modelOverrides).length : 0;
    return [
        `${models} model${models === 1 ? '' : 's'}`,
        provider.api || 'built-in api',
        `key ${maskSecret(provider.apiKey)}`,
        ...(overrides ? [`${overrides} override${overrides === 1 ? '' : 's'}`] : []),
    ].join(' · ');
}
export function modelDetail(model) {
    const input = model.input?.includes('image') ? 'text+image' : 'text';
    return [
        `${formatTokens(model.contextWindow)} ctx`,
        `${formatTokens(model.maxTokens)} out`,
        model.reasoning ? 'reasoning' : 'no reasoning',
        input,
    ].join(' · ');
}
export function overrideDetail(override) {
    const keys = Object.keys(override).filter(key => override[key] !== undefined);
    return keys.length ? keys.join(', ') : 'no fields';
}
