import { choose, checklist, view, working } from './pi-ui.js';
import { clip } from './terminal.js';
import { errorMessage } from './errors.js';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_COST, DEFAULT_MAX_TOKENS, THINKING_LEVELS, formatTokens, maskSecret, modelDetail, overrideDetail, parseJsonConfig, providerDetail, providerOf, providersOf, readModelDefaults, readModels, readSettings, removeModel, removeOverride, removeProvider, secretKind, setDefaultSelection, setEnabledPatterns, setModel, setOverride, setProvider, validProviderId, validateModelsValue, writeModels, writeSettings, } from './model-config.js';
import { DiscoveryError, describeDiscoveryPlan, fetchProviderModels, newDiscoveredModels, planDiscovery, } from './model-discovery.js';
const API_OPTIONS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'azure-openai-responses'];
const THINKING_UNSET = '(unset)';
const defaultRef = (defaults) => defaults.provider && defaults.model ? `${defaults.provider}/${defaults.model}${defaults.thinking ? ` · ${defaults.thinking}` : ''}` : '(not set)';
export function modelGlobalStatus(models, settings) {
    const providers = providersOf(models.value ?? {}).length;
    const count = providersOf(models.value ?? {}).reduce((total, [, provider]) => total + (provider.models?.length ?? 0), 0);
    const defaults = readModelDefaults(settings.value ?? {});
    const status = models.error ? `models.json invalid · fix with the raw editor`
        : `${providers} provider${providers === 1 ? '' : 's'} · ${count} model${count === 1 ? '' : 's'} · default ${defaultRef(defaults)}`;
    return `${status} · ${models.path} · changes apply after /reload or restart`;
}
export function buildModelRows(models, settings) {
    const defaults = readModelDefaults(settings.value ?? {});
    const providers = providersOf(models.value ?? {});
    const modelCount = providers.reduce((total, [, provider]) => total + (provider.models?.length ?? 0), 0);
    const rows = [];
    const invalid = Boolean(models.error);
    if (!invalid) {
        rows.push({ id: 'model:page:providers', label: `Providers (${providers.length})…`, detail: 'global models.json' });
        rows.push({ id: 'model:page:models', label: `Models (${modelCount})…`, detail: 'global models.json' });
    }
    rows.push({
        id: 'model:defaults',
        label: `Defaults: ${defaultRef(defaults)}`,
        detail: settings.error ? 'settings.json invalid' : 'global · new sessions',
    });
    rows.push({
        id: 'model:enabled',
        label: `Enabled models: ${defaults.enabledModels?.length ? `${defaults.enabledModels.length} pattern${defaults.enabledModels.length === 1 ? '' : 's'}` : 'all models'}`,
        detail: 'startup selection and model cycling',
    });
    if (!invalid)
        rows.push({ id: 'model:add-override', label: '+ Add model override…', detail: 'built-in or extension model' });
    rows.push({
        id: 'model:raw',
        label: 'Edit models.json (raw JSON)…',
        detail: invalid ? 'invalid file; repair it here first' : 'contains API keys; visible while editing',
    });
    return rows;
}
export function buildProviderRows(models) {
    if (models.error)
        return [{
                id: 'model:raw',
                label: 'Edit models.json (raw JSON)…',
                detail: 'invalid file; repair it here first',
            }];
    return providersOf(models.value ?? {}).map(([providerId, provider]) => ({
        id: `model:provider:${providerId}`,
        label: provider.name || providerId,
        detail: `${provider.name && provider.name !== providerId ? `${providerId} · ` : ''}${providerDetail(provider)}`,
        editable: true,
    }));
}
export function buildModelListRows(models) {
    if (models.error)
        return [{
                id: 'model:raw',
                label: 'Edit models.json (raw JSON)…',
                detail: 'invalid file; repair it here first',
            }];
    const rows = [];
    for (const [providerId, provider] of providersOf(models.value ?? {})) {
        for (const model of provider.models ?? []) {
            rows.push({
                id: `model:entry:${providerId}/${model.id}`,
                label: `${provider.name || providerId} / ${model.name || model.id}`,
                detail: `${model.name && model.name !== model.id ? `${model.id} · ` : ''}${modelDetail(model)}`,
                editable: true,
            });
        }
    }
    return rows;
}
export function buildModelPages(models, settings) {
    return {
        root: buildModelRows(models, settings),
        providers: buildProviderRows(models),
        models: buildModelListRows(models),
    };
}
async function editFields(ctx, title, draft, fields, save) {
    while (true) {
        const action = await choose(ctx, title, [
            { label: 'Save changes', value: ':save' },
            { label: 'Cancel', value: ':cancel' },
            ...fields.map(field => ({ label: `${field.label}: ${clip(field.detail(draft), 72)}`, value: field.id })),
        ], { search: false });
        if (!action || action === ':cancel')
            return false;
        if (action === ':save') {
            try {
                await save(draft);
                return true;
            }
            catch (error) {
                await view(ctx, 'Cannot save configuration', errorMessage(error));
            }
            continue;
        }
        const field = fields.find(item => item.id === action);
        if (!field)
            continue;
        try {
            await field.edit(draft);
        }
        catch (error) {
            ctx.ui.notify(errorMessage(error), 'error');
        }
    }
}
async function inputText(ctx, title, current, options = {}) {
    const placeholder = options.placeholder ?? (current ? `current: ${clip(current, 80)} · blank clears` : 'blank clears');
    const value = await ctx.ui.input(title, placeholder);
    if (value === undefined)
        return undefined;
    const text = value.trim();
    if (!text) {
        if (options.required) {
            ctx.ui.notify('Value is required.', 'warning');
            return undefined;
        }
        return null;
    }
    if (options.url) {
        try {
            const url = new URL(text);
            if (url.protocol !== 'http:' && url.protocol !== 'https:')
                throw new Error();
        }
        catch {
            ctx.ui.notify('Use an http(s) URL.', 'error');
            return undefined;
        }
    }
    return text;
}
async function inputNumber(ctx, title, current, options = {}) {
    const value = await ctx.ui.input(title, current !== undefined ? `current: ${current} · blank unsets` : 'blank = unset');
    if (value === undefined)
        return undefined;
    const text = value.trim();
    if (!text)
        return options.allowUnset === false ? undefined : null;
    const number = Number(text);
    if (!Number.isFinite(number) || number < 0 || (options.integer && !Number.isSafeInteger(number)) || (options.positive && number <= 0)) {
        ctx.ui.notify(options.integer ? 'Enter a whole number.' : 'Enter a number.', 'error');
        return undefined;
    }
    return number;
}
async function editJsonObject(ctx, title, current) {
    const text = await ctx.ui.editor(`${title} (JSON)`, current ? JSON.stringify(current, null, 2) : '');
    if (text === undefined)
        return undefined;
    if (!text.trim())
        return null;
    let parsed;
    try {
        parsed = parseJsonConfig(text);
    }
    catch (error) {
        throw new Error(`Invalid JSON: ${errorMessage(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error(`${title} must be a JSON object.`);
    return parsed;
}
async function chooseValue(ctx, title, options, current, allowUnset = false) {
    const entries = options.map(item => ({ ...item, label: `${item.label}${current === item.value ? ' (current)' : ''}` }));
    if (allowUnset)
        entries.push({ label: THINKING_UNSET, value: null });
    entries.push({ label: 'Cancel', value: undefined });
    return choose(ctx, title, entries, { search: false });
}
async function chooseApi(ctx, current, allowUnset) {
    const selected = await choose(ctx, 'API', [
        ...API_OPTIONS.map(value => ({ label: `${value}${current === value ? ' (current)' : ''}`, value })),
        { label: 'Custom…', value: ':custom' },
        ...(allowUnset || current ? [{ label: 'Clear', value: ':clear' }] : []),
        { label: 'Cancel', value: ':cancel' },
    ], { search: false });
    if (!selected || selected === ':cancel')
        return undefined;
    if (selected === ':clear')
        return null;
    if (selected !== ':custom')
        return selected;
    return inputText(ctx, 'Custom API id', current, { required: true });
}
function notifySaved(ctx, label, result) {
    ctx.ui.notify(`${label}. ${result.backup ? `Backup: ${result.backup}. ` : ''}Run /reload or restart Pi to apply.`, 'info');
}
function requireModels(doc) {
    if (doc.error || !doc.value)
        throw new Error(doc.error ?? `${doc.path} is unavailable`);
    return doc.value;
}
/** Save a candidate against the revision captured before the form opened. */
async function saveModelsFrom(ctx, base, candidate, label) {
    const errors = validateModelsValue(candidate);
    if (errors.length)
        throw new Error(errors.join('\n'));
    notifySaved(ctx, label, await writeModels(candidate, { expectedRevision: base.revision }));
}
/** Save a candidate against the revision captured before the form opened. */
async function saveSettingsFrom(ctx, base, candidate, label) {
    notifySaved(ctx, label, await writeSettings(candidate, { expectedRevision: base.revision }));
}
function providerFields(ctx) {
    const fields = [
        {
            id: 'name', label: 'Name', detail: provider => provider.name ?? '(unset)',
            edit: async (provider) => { const value = await inputText(ctx, 'Provider name', provider.name); if (value !== undefined)
                provider.name = value ?? undefined; },
        },
        {
            id: 'baseUrl', label: 'Base URL', detail: provider => provider.baseUrl ?? '(unset)',
            edit: async (provider) => { const value = await inputText(ctx, 'Base URL', provider.baseUrl, { url: true, placeholder: 'https://api.example.com/v1' }); if (value !== undefined)
                provider.baseUrl = value ?? undefined; },
        },
        {
            id: 'api', label: 'API', detail: provider => provider.api ?? '(inherit/unset)',
            edit: async (provider) => { const value = await chooseApi(ctx, provider.api, true); if (value !== undefined)
                provider.api = value ?? undefined; },
        },
        {
            id: 'apiKey', label: 'API key', detail: provider => `${secretKind(provider.apiKey)} · ${maskSecret(provider.apiKey)}`,
            edit: async (provider) => {
                const action = await choose(ctx, `API key — ${maskSecret(provider.apiKey)}`, [
                    { label: 'Literal key…', value: 'literal' },
                    { label: 'Environment variable…', value: 'env' },
                    { label: 'Command… (runs locally)', value: 'command' },
                    { label: 'Clear', value: 'clear' },
                    { label: 'Cancel', value: 'cancel' },
                ], { search: false });
                if (!action || action === 'cancel')
                    return;
                if (action === 'clear') {
                    delete provider.apiKey;
                    return;
                }
                if (action === 'literal') {
                    const value = await ctx.ui.input('Literal API key (visible while typing)', provider.apiKey ? 'blank keeps current' : 'paste the key');
                    if (value?.trim())
                        provider.apiKey = value.trim();
                }
                else if (action === 'env') {
                    const value = await inputText(ctx, 'Environment variable name', provider.apiKey?.startsWith('$') ? provider.apiKey.slice(1) : undefined, { required: true, placeholder: 'OPENAI_API_KEY' });
                    if (value) {
                        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
                            ctx.ui.notify('Invalid environment variable name.', 'error');
                            return;
                        }
                        provider.apiKey = `$${value}`;
                    }
                }
                else {
                    ctx.ui.notify('This command runs locally on this machine. Only enter a command you trust.', 'warning');
                    const value = await ctx.ui.input('Auth command (runs locally; without !)', provider.apiKey?.startsWith('!') ? 'blank keeps current' : 'prints the key on one line');
                    if (value?.trim())
                        provider.apiKey = `!${value.trim().replace(/^!/, '')}`;
                }
            },
        },
        {
            id: 'authHeader', label: 'Authorization: Bearer', detail: provider => provider.authHeader ? 'true' : 'false',
            edit: async (provider) => { provider.authHeader = !provider.authHeader; },
        },
        {
            id: 'headers', label: 'Headers', detail: provider => provider.headers ? `${Object.keys(provider.headers).length} entries` : '(unset)',
            edit: async (provider) => { const value = await editJsonObject(ctx, 'Provider headers', provider.headers); if (value !== undefined)
                provider.headers = value ?? undefined; },
        },
        {
            id: 'compat', label: 'Compatibility', detail: provider => provider.compat ? `${Object.keys(provider.compat).length} fields` : '(unset)',
            edit: async (provider) => { const value = await editJsonObject(ctx, 'Provider compatibility', provider.compat); if (value !== undefined)
                provider.compat = value ?? undefined; },
        },
        {
            id: 'oauth', label: 'OAuth', detail: provider => provider.oauth ?? '(none)',
            edit: async (provider) => {
                const value = await choose(ctx, 'OAuth flow', [{ label: '(none)', value: '' }, { label: 'radius', value: 'radius' }, { label: 'Cancel', value: ':cancel' }], { search: false });
                if (value === undefined || value === ':cancel')
                    return;
                if (value === 'radius')
                    provider.oauth = 'radius';
                else
                    delete provider.oauth;
            },
        },
    ];
    return fields;
}
// The field closures need the command context; editProvider assigns it for the
// duration of one form. Keeping it here avoids threading ctx through every field.
async function editProvider(ctx, providerId, provider, create, base) {
    const draft = structuredClone(provider);
    return editFields(ctx, `Provider ${providerId} — edit fields (blank clears; Esc keeps)`, draft, providerFields(ctx), async (saved) => {
        const candidate = structuredClone(requireModels(base));
        if (create && candidate.providers?.[providerId])
            throw new Error(`Provider already exists: ${providerId}`);
        setProvider(candidate, providerId, saved);
        await saveModelsFrom(ctx, base, candidate, `Provider ${providerId} saved`);
    });
}
function modelFields(ctx, override) {
    const fields = [
        {
            id: 'name', label: 'Name', detail: model => model.name ?? '(unset)',
            edit: async (model) => { const value = await inputText(ctx, 'Model name', model.name); if (value !== undefined)
                model.name = value ?? undefined; },
        },
    ];
    if (!override) {
        fields.push({
            id: 'api', label: 'API', detail: model => model.api ?? '(inherit provider)',
            edit: async (model) => { const value = await chooseApi(ctx, model.api, true); if (value !== undefined)
                model.api = value ?? undefined; },
        }, {
            id: 'baseUrl', label: 'Base URL', detail: model => model.baseUrl ?? '(inherit provider)',
            edit: async (model) => { const value = await inputText(ctx, 'Model base URL', model.baseUrl, { url: true }); if (value !== undefined)
                model.baseUrl = value ?? undefined; },
        });
    }
    fields.push({
        id: 'reasoning', label: 'Reasoning', detail: model => override ? (model.reasoning === undefined ? '(inherit)' : String(model.reasoning)) : String(model.reasoning ?? false),
        edit: async (model) => {
            if (!override) {
                model.reasoning = !(model.reasoning ?? false);
                return;
            }
            const value = await choose(ctx, 'Reasoning override', [
                { label: '(inherit)', value: null }, { label: 'true', value: true }, { label: 'false', value: false }, { label: 'Cancel', value: undefined },
            ], { search: false });
            if (value === undefined)
                return;
            if (value === null)
                delete model.reasoning;
            else
                model.reasoning = value;
        },
    }, {
        id: 'input', label: 'Input', detail: model => model.input?.includes('image') ? 'text+image' : override && !model.input ? '(inherit)' : 'text',
        edit: async (model) => {
            const value = await choose(ctx, 'Model input', [
                { label: 'text', value: ['text'] }, { label: 'text+image', value: ['text', 'image'] },
                ...(override ? [{ label: '(inherit)', value: null }] : []),
                { label: 'Cancel', value: undefined },
            ], { search: false });
            if (value === undefined)
                return;
            if (value === null)
                delete model.input;
            else
                model.input = value;
        },
    }, {
        id: 'contextWindow', label: 'Context window', detail: model => model.contextWindow ? formatTokens(model.contextWindow) : (override ? '(inherit)' : `default ${formatTokens(DEFAULT_CONTEXT_WINDOW)}`),
        edit: async (model) => { const value = await inputNumber(ctx, 'Context window', model.contextWindow, { integer: true, positive: true }); if (value !== undefined)
            model.contextWindow = value ?? undefined; },
    }, {
        id: 'maxTokens', label: 'Max output', detail: model => model.maxTokens ? formatTokens(model.maxTokens) : (override ? '(inherit)' : `default ${formatTokens(DEFAULT_MAX_TOKENS)}`),
        edit: async (model) => { const value = await inputNumber(ctx, 'Max output tokens', model.maxTokens, { integer: true, positive: true }); if (value !== undefined)
            model.maxTokens = value ?? undefined; },
    }, {
        id: 'cost', label: 'Cost per Mtok', detail: model => model.cost
            ? `in ${model.cost.input ?? '(inherit)'} · out ${model.cost.output ?? '(inherit)'} · read ${model.cost.cacheRead ?? '(inherit)'} · write ${model.cost.cacheWrite ?? '(inherit)'}`
            : '(unset)',
        edit: async (model) => {
            while (true) {
                const action = await choose(ctx, 'Cost per million tokens', [
                    { label: `Input: ${model.cost?.input ?? '(unset)'}`, value: 'input' },
                    { label: `Output: ${model.cost?.output ?? '(unset)'}`, value: 'output' },
                    { label: `Cache read: ${model.cost?.cacheRead ?? '(unset)'}`, value: 'cacheRead' },
                    { label: `Cache write: ${model.cost?.cacheWrite ?? '(unset)'}`, value: 'cacheWrite' },
                    { label: 'Cancel', value: ':cancel' },
                ], { search: false });
                if (!action || action === ':cancel')
                    return;
                const key = action;
                const value = await inputNumber(ctx, `Cost · ${key}`, model.cost?.[key]);
                if (value === undefined)
                    continue;
                model.cost ??= {};
                if (value === null)
                    delete model.cost[key];
                else
                    model.cost[key] = value;
                if (!Object.keys(model.cost).length)
                    delete model.cost;
            }
        },
    }, {
        id: 'thinkingLevelMap', label: 'Thinking level map', detail: model => model.thinkingLevelMap ? `${Object.keys(model.thinkingLevelMap).length} levels` : '(unset)',
        edit: async (model) => { const value = await editJsonObject(ctx, 'thinkingLevelMap', model.thinkingLevelMap); if (value !== undefined)
            model.thinkingLevelMap = value; },
    }, {
        id: 'inputLimits', label: 'Input limits', detail: model => model.inputLimits ? `${Object.keys(model.inputLimits).length} fields` : '(unset)',
        edit: async (model) => { const value = await editJsonObject(ctx, 'inputLimits', model.inputLimits); if (value !== undefined)
            model.inputLimits = value ?? undefined; },
    }, {
        id: 'promptCache', label: 'Prompt cache', detail: model => model.promptCache ? `${Object.keys(model.promptCache).length} fields` : '(unset)',
        edit: async (model) => { const value = await editJsonObject(ctx, 'promptCache', model.promptCache); if (value !== undefined)
            model.promptCache = value ?? undefined; },
    }, {
        id: 'samplingParams', label: 'Sampling params', detail: model => model.samplingParams ? `${Object.keys(model.samplingParams).length} fields` : '(unset)',
        edit: async (model) => { const value = await editJsonObject(ctx, 'samplingParams', model.samplingParams); if (value !== undefined)
            model.samplingParams = value ?? undefined; },
    }, {
        id: 'samplingParamsByThinkingLevel', label: 'Sampling by thinking', detail: model => model.samplingParamsByThinkingLevel ? `${Object.keys(model.samplingParamsByThinkingLevel).length} levels` : '(unset)',
        edit: async (model) => { const value = await editJsonObject(ctx, 'samplingParamsByThinkingLevel', model.samplingParamsByThinkingLevel); if (value !== undefined)
            model.samplingParamsByThinkingLevel = value ?? undefined; },
    }, {
        id: 'headers', label: 'Headers', detail: model => model.headers ? `${Object.keys(model.headers).length} entries` : '(unset)',
        edit: async (model) => { const value = await editJsonObject(ctx, 'Model headers', model.headers); if (value !== undefined)
            model.headers = value ?? undefined; },
    }, {
        id: 'compat', label: 'Compatibility', detail: model => model.compat ? `${Object.keys(model.compat).length} fields` : '(unset)',
        edit: async (model) => { const value = await editJsonObject(ctx, 'Model compatibility', model.compat); if (value !== undefined)
            model.compat = value ?? undefined; },
    });
    return fields;
}
function normalizeModel(draft) {
    const model = structuredClone(draft);
    model.id = model.id.trim();
    model.reasoning = model.reasoning ?? false;
    model.input = model.input?.length ? [...new Set(model.input)] : ['text'];
    model.contextWindow = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    model.maxTokens = model.maxTokens ?? DEFAULT_MAX_TOKENS;
    if (model.maxTokens > model.contextWindow)
        model.maxTokens = model.contextWindow;
    const cost = model.cost ?? {};
    model.cost = {
        ...cost,
        input: cost.input ?? 0,
        output: cost.output ?? 0,
        cacheRead: cost.cacheRead ?? 0,
        cacheWrite: cost.cacheWrite ?? 0,
    };
    if (!model.name)
        delete model.name;
    if (!model.api)
        delete model.api;
    if (!model.baseUrl)
        delete model.baseUrl;
    return model;
}
async function editModel(ctx, providerId, model, create, base) {
    const draft = structuredClone(model);
    return editFields(ctx, `Model ${providerId}/${model.id} — edit fields (blank clears; Esc keeps)`, draft, modelFields(ctx, false), async (saved) => {
        const candidate = structuredClone(requireModels(base));
        const provider = providerOf(candidate, providerId);
        if (!provider)
            throw new Error(`Provider not found: ${providerId}`);
        if (create && provider.models?.some(item => item.id === saved.id))
            throw new Error(`Model already exists: ${providerId}/${saved.id}`);
        setModel(candidate, providerId, normalizeModel(saved));
        await saveModelsFrom(ctx, base, candidate, `Model ${providerId}/${saved.id} saved`);
    });
}
function normalizeOverride(draft) {
    const result = structuredClone(draft);
    for (const key of Object.keys(result)) {
        const value = result[key];
        if (value === undefined || (typeof value === 'string' && !value.trim()))
            delete result[key];
    }
    if (result.cost) {
        const cost = { ...result.cost };
        for (const key of Object.keys(cost))
            if (cost[key] === undefined)
                delete cost[key];
        if (Object.keys(cost).length)
            result.cost = cost;
        else
            delete result.cost;
    }
    if (result.input && !result.input.length)
        delete result.input;
    return result;
}
async function editOverride(ctx, providerId, modelId, override, base) {
    const draft = structuredClone(override);
    return editFields(ctx, `Override ${providerId}/${modelId} — edit fields (blank inherits)`, draft, modelFields(ctx, true), async (saved) => {
        const candidate = structuredClone(requireModels(base));
        setOverride(candidate, providerId, modelId, normalizeOverride(saved));
        await saveModelsFrom(ctx, base, candidate, `Override ${providerId}/${modelId} saved`);
    });
}
export async function addProviderFlow(ctx) {
    const base = await readModels();
    if (base.error) {
        await view(ctx, 'models.json is invalid', `${base.error}\n\nRepair it with the raw editor first.`);
        return;
    }
    const id = await inputText(ctx, 'New provider id', undefined, { required: true, placeholder: 'letters, numbers, dots, underscores, hyphens' });
    if (!id)
        return;
    try {
        validProviderId(id);
    }
    catch (error) {
        ctx.ui.notify(errorMessage(error), 'error');
        return;
    }
    if (base.value?.providers?.[id]) {
        ctx.ui.notify(`Provider already exists: ${id}`, 'error');
        return;
    }
    await editProvider(ctx, id, { api: 'openai-completions' }, true, base);
}
export async function addModelFlow(ctx, providerId) {
    const base = await readModels();
    if (base.error) {
        ctx.ui.notify(base.error, 'error');
        return;
    }
    const id = await inputText(ctx, 'New model id', undefined, { required: true, placeholder: 'exact model id sent to the API' });
    if (!id)
        return;
    const provider = providerOf(requireModels(base), providerId);
    if (!provider) {
        ctx.ui.notify(`Provider not found: ${providerId}`, 'error');
        return;
    }
    if (provider.models?.some(model => model.id === id)) {
        ctx.ui.notify(`Model already exists: ${providerId}/${id}`, 'error');
        return;
    }
    await editModel(ctx, providerId, {
        id, reasoning: false, input: ['text'], contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, cost: { ...DEFAULT_COST },
    }, true, base);
}
export async function addModelToProviderFlow(ctx) {
    const base = await readModels();
    if (base.error) {
        ctx.ui.notify(base.error, 'error');
        return;
    }
    const providers = providersOf(requireModels(base));
    if (!providers.length) {
        ctx.ui.notify('No providers. Add a provider first.', 'warning');
        return;
    }
    let providerId;
    if (providers.length === 1)
        providerId = providers[0][0];
    else {
        const selected = await choose(ctx, 'Add model — provider', [
            ...providers.map(([id, provider]) => ({
                label: `${provider.name || id}${provider.name && provider.name !== id ? ` (${id})` : ''}`,
                value: id,
            })),
            { label: 'Cancel', value: ':cancel' },
        ]);
        if (!selected || selected === ':cancel')
            return;
        providerId = selected;
    }
    await addModelFlow(ctx, providerId);
}
export async function addOverrideFlow(ctx) {
    const base = await readModels();
    if (base.error) {
        ctx.ui.notify(base.error, 'error');
        return;
    }
    const providers = providersOf(requireModels(base)).map(([id]) => id);
    const providerId = await choose(ctx, 'Add model override — provider', [
        ...providers.map(id => ({ label: id, value: id })),
        { label: 'Enter provider id…', value: ':custom' },
        { label: 'Cancel', value: ':cancel' },
    ]);
    if (!providerId || providerId === ':cancel')
        return;
    let targetProvider = providerId;
    if (providerId === ':custom') {
        const value = await inputText(ctx, 'Provider id', undefined, { required: true, placeholder: 'built-in or extension provider id' });
        if (!value)
            return;
        targetProvider = value;
    }
    const modelId = await inputText(ctx, 'Model id to override', undefined, { required: true, placeholder: 'exact built-in/extension model id' });
    if (!modelId)
        return;
    const existing = providerOf(requireModels(base), targetProvider)?.modelOverrides?.[modelId];
    await editOverride(ctx, targetProvider, modelId, existing ?? {}, base);
}
async function providerModelsFlow(ctx, providerId) {
    const doc = await readModels();
    if (doc.error) {
        ctx.ui.notify(doc.error, 'error');
        return;
    }
    const provider = providerOf(requireModels(doc), providerId);
    if (!provider) {
        ctx.ui.notify(`Provider not found: ${providerId}`, 'error');
        return;
    }
    const configured = provider.models ?? [];
    if (!configured.length) {
        ctx.ui.notify('No models. Use A on the Models page to add one.', 'info');
        return;
    }
    const action = await choose(ctx, `Provider ${providerId} — models`, configured.map(model => ({ label: `${model.name || model.id} · ${modelDetail(model)}`, value: `model:${model.id}` })));
    if (!action)
        return;
    await modelFlow(ctx, providerId, action.slice('model:'.length));
}
async function setDefaultFlow(ctx, providerId, modelId) {
    const doc = await readSettings();
    if (doc.error) {
        ctx.ui.notify(doc.error, 'error');
        return;
    }
    const candidate = structuredClone(doc.value ?? {});
    setDefaultSelection(candidate, { provider: providerId, model: modelId });
    notifySaved(ctx, `Default model set to ${providerId}/${modelId} for new sessions`, await writeSettings(candidate, { expectedRevision: doc.revision }));
}
async function toggleEnabledFlow(ctx, providerId, modelId) {
    const doc = await readSettings();
    if (doc.error) {
        ctx.ui.notify(doc.error, 'error');
        return;
    }
    const patterns = readModelDefaults(doc.value ?? {}).enabledModels ?? [];
    const ref = `${providerId}/${modelId}`;
    const next = patterns.includes(ref) ? patterns.filter(pattern => pattern !== ref) : [...patterns, ref];
    const candidate = structuredClone(doc.value ?? {});
    setEnabledPatterns(candidate, next);
    notifySaved(ctx, patterns.includes(ref) ? `Removed ${ref} from enabled models` : `Added ${ref} to enabled models`, await writeSettings(candidate, { expectedRevision: doc.revision }));
    ctx.ui.notify('Enabled models only control startup selection and model cycling; /model still lists every available model.', 'info');
}
export async function modelFlow(ctx, providerId, modelId) {
    while (true) {
        const doc = await readModels();
        if (doc.error) {
            ctx.ui.notify(doc.error, 'error');
            return;
        }
        const provider = providerOf(requireModels(doc), providerId);
        const model = provider?.models?.find(item => item.id === modelId);
        if (!provider || !model) {
            ctx.ui.notify(`Model not found: ${providerId}/${modelId}`, 'error');
            return;
        }
        const defaults = readModelDefaults((await readSettings()).value ?? {});
        const isDefault = defaults.provider === providerId && defaults.model === modelId;
        const enabled = defaults.enabledModels?.includes(`${providerId}/${modelId}`) ?? false;
        const action = await choose(ctx, `Model ${providerId}/${modelId} · ${model.name || ''}`, [
            { label: 'Edit model fields…', value: 'fields' },
            { label: 'Edit model JSON…', value: 'json' },
            { label: 'Duplicate model…', value: 'duplicate' },
            ...(isDefault ? [] : [{ label: 'Use as default for new sessions', value: 'default' }]),
            { label: enabled ? 'Remove from enabled models' : 'Add to enabled models', value: 'enabled' },
            { label: 'Delete model…', value: 'delete' },
        ], { search: false });
        if (!action)
            return;
        if (action === 'fields') {
            await editModel(ctx, providerId, model, false, doc);
            continue;
        }
        if (action === 'json') {
            await editModelJsonFlow(ctx, providerId, modelId);
            continue;
        }
        if (action === 'default') {
            await setDefaultFlow(ctx, providerId, modelId);
            continue;
        }
        if (action === 'enabled') {
            await toggleEnabledFlow(ctx, providerId, modelId);
            continue;
        }
        if (action === 'duplicate') {
            const id = await inputText(ctx, 'New model id', undefined, { required: true });
            if (!id)
                continue;
            if (provider.models?.some(item => item.id === id)) {
                ctx.ui.notify(`Model already exists: ${providerId}/${id}`, 'error');
                continue;
            }
            const candidate = structuredClone(requireModels(doc));
            setModel(candidate, providerId, { ...structuredClone(model), id });
            try {
                await saveModelsFrom(ctx, doc, candidate, `Model ${providerId}/${id} duplicated`);
            }
            catch (error) {
                await view(ctx, 'Cannot duplicate model', errorMessage(error));
            }
            continue;
        }
        if (action === 'delete') {
            const notes = [
                isDefault ? 'This model is the configured default for new sessions.' : '',
                enabled ? 'This model has an exact enabledModels pattern.' : '',
                'The current session is unchanged.',
            ].filter(Boolean).join(' ');
            if (!await ctx.ui.confirm(`Delete model ${providerId}/${modelId}?`, `Removes one model from models.json. ${notes}`))
                return;
            const candidate = structuredClone(requireModels(doc));
            try {
                removeModel(candidate, providerId, modelId);
                await saveModelsFrom(ctx, doc, candidate, `Model ${providerId}/${modelId} deleted`);
            }
            catch (error) {
                await view(ctx, 'Cannot delete model', errorMessage(error));
            }
            return;
        }
    }
}
async function overridesFlow(ctx, providerId) {
    while (true) {
        const doc = await readModels();
        if (doc.error) {
            ctx.ui.notify(doc.error, 'error');
            return;
        }
        const provider = providerOf(requireModels(doc), providerId);
        if (!provider) {
            ctx.ui.notify(`Provider not found: ${providerId}`, 'error');
            return;
        }
        const overrides = Object.entries(provider.modelOverrides ?? {});
        const action = await choose(ctx, `Provider ${providerId} — model overrides`, [
            ...overrides.map(([modelId, override]) => ({ label: `${modelId} · ${overrideDetail(override)}`, value: `override:${modelId}` })),
            { label: '+ Add model override…', value: ':add' },
        ]);
        if (!action)
            return;
        if (action === ':add') {
            const modelId = await inputText(ctx, 'Model id to override', undefined, { required: true });
            if (!modelId)
                continue;
            const existing = provider.modelOverrides?.[modelId];
            await editOverride(ctx, providerId, modelId, existing ?? {}, doc);
            continue;
        }
        if (action.startsWith('override:'))
            await overrideFlow(ctx, providerId, action.slice('override:'.length));
    }
}
async function overrideFlow(ctx, providerId, modelId) {
    while (true) {
        const doc = await readModels();
        if (doc.error) {
            ctx.ui.notify(doc.error, 'error');
            return;
        }
        const override = providerOf(requireModels(doc), providerId)?.modelOverrides?.[modelId];
        if (!override) {
            ctx.ui.notify(`Override not found: ${providerId}/${modelId}`, 'error');
            return;
        }
        const action = await choose(ctx, `Override ${providerId}/${modelId} — ${overrideDetail(override)}`, [
            { label: 'Edit override fields…', value: 'fields' },
            { label: 'Edit override JSON…', value: 'json' },
            { label: 'Delete override…', value: 'delete' },
        ], { search: false });
        if (!action)
            return;
        if (action === 'fields') {
            await editOverride(ctx, providerId, modelId, override, doc);
            continue;
        }
        if (action === 'json') {
            await editOverrideJsonFlow(ctx, providerId, modelId);
            continue;
        }
        if (action === 'delete') {
            if (!await ctx.ui.confirm(`Delete override ${providerId}/${modelId}?`, 'Removes the override fields. The model itself and the current session are unchanged.'))
                return;
            const candidate = structuredClone(requireModels(doc));
            try {
                removeOverride(candidate, providerId, modelId);
                await saveModelsFrom(ctx, doc, candidate, `Override ${providerId}/${modelId} deleted`);
            }
            catch (error) {
                await view(ctx, 'Cannot delete override', errorMessage(error));
            }
            return;
        }
    }
}
async function editModelsJsonFlow(ctx) {
    const doc = await readModels();
    const text = await ctx.ui.editor('models.json — contains API keys (visible while editing)', doc.raw || '{\n  "providers": {}\n}');
    if (text === undefined || text.trimEnd() === doc.raw.trimEnd())
        return;
    let parsed;
    try {
        parsed = parseJsonConfig(text);
    }
    catch (error) {
        await view(ctx, 'Invalid JSON', errorMessage(error));
        return;
    }
    const errors = validateModelsValue(parsed);
    if (errors.length) {
        await view(ctx, 'Invalid models.json', errors.join('\n'));
        return;
    }
    try {
        notifySaved(ctx, 'models.json saved', await writeModels(parsed, { expectedRevision: doc.revision }));
    }
    catch (error) {
        await view(ctx, 'Cannot save models.json', errorMessage(error));
    }
}
async function editProviderJsonFlow(ctx, providerId) {
    const doc = await readModels();
    if (doc.error) {
        ctx.ui.notify(doc.error, 'error');
        return;
    }
    const provider = providerOf(requireModels(doc), providerId);
    if (!provider) {
        ctx.ui.notify(`Provider not found: ${providerId}`, 'error');
        return;
    }
    const text = await ctx.ui.editor(`Provider ${providerId} (JSON, contains API keys)`, JSON.stringify(provider, null, 2));
    if (text === undefined || text.trimEnd() === JSON.stringify(provider, null, 2).trimEnd())
        return;
    let parsed;
    try {
        parsed = parseJsonConfig(text);
    }
    catch (error) {
        await view(ctx, 'Invalid JSON', errorMessage(error));
        return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        await view(ctx, 'Invalid provider', 'Provider JSON must be an object.');
        return;
    }
    const candidate = structuredClone(requireModels(doc));
    setProvider(candidate, providerId, parsed);
    try {
        await saveModelsFrom(ctx, doc, candidate, `Provider ${providerId} saved`);
    }
    catch (error) {
        await view(ctx, 'Cannot save provider', errorMessage(error));
    }
}
async function editModelJsonFlow(ctx, providerId, modelId) {
    const doc = await readModels();
    if (doc.error) {
        ctx.ui.notify(doc.error, 'error');
        return;
    }
    const model = providerOf(requireModels(doc), providerId)?.models?.find(item => item.id === modelId);
    if (!model) {
        ctx.ui.notify(`Model not found: ${providerId}/${modelId}`, 'error');
        return;
    }
    const text = await ctx.ui.editor(`Model ${providerId}/${modelId} (JSON)`, JSON.stringify(model, null, 2));
    if (text === undefined || text.trimEnd() === JSON.stringify(model, null, 2).trimEnd())
        return;
    let parsed;
    try {
        parsed = parseJsonConfig(text);
    }
    catch (error) {
        await view(ctx, 'Invalid JSON', errorMessage(error));
        return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        await view(ctx, 'Invalid model', 'Model JSON must be an object.');
        return;
    }
    if (parsed.id !== modelId) {
        await view(ctx, 'Model id changed', 'Keep the existing id here. Use Duplicate if you need a second model entry.');
        return;
    }
    const candidate = structuredClone(requireModels(doc));
    setModel(candidate, providerId, parsed);
    try {
        await saveModelsFrom(ctx, doc, candidate, `Model ${providerId}/${modelId} saved`);
    }
    catch (error) {
        await view(ctx, 'Cannot save model', errorMessage(error));
    }
}
async function editOverrideJsonFlow(ctx, providerId, modelId) {
    const doc = await readModels();
    if (doc.error) {
        ctx.ui.notify(doc.error, 'error');
        return;
    }
    const override = providerOf(requireModels(doc), providerId)?.modelOverrides?.[modelId];
    if (!override) {
        ctx.ui.notify(`Override not found: ${providerId}/${modelId}`, 'error');
        return;
    }
    const text = await ctx.ui.editor(`Override ${providerId}/${modelId} (JSON)`, JSON.stringify(override, null, 2));
    if (text === undefined || text.trimEnd() === JSON.stringify(override, null, 2).trimEnd())
        return;
    let parsed;
    try {
        parsed = parseJsonConfig(text);
    }
    catch (error) {
        await view(ctx, 'Invalid JSON', errorMessage(error));
        return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        await view(ctx, 'Invalid override', 'Override JSON must be an object.');
        return;
    }
    const candidate = structuredClone(requireModels(doc));
    setOverride(candidate, providerId, modelId, parsed);
    try {
        await saveModelsFrom(ctx, doc, candidate, `Override ${providerId}/${modelId} saved`);
    }
    catch (error) {
        await view(ctx, 'Cannot save override', errorMessage(error));
    }
}
export async function providerFlow(ctx, providerId) {
    while (true) {
        const doc = await readModels();
        if (doc.error) {
            await view(ctx, `${doc.path} is invalid`, `${doc.error}\n\nRepair it with the raw editor first.`);
            return;
        }
        const provider = providerOf(requireModels(doc), providerId);
        if (!provider) {
            ctx.ui.notify(`Provider not found: ${providerId}`, 'error');
            return;
        }
        const overrideCount = Object.keys(provider.modelOverrides ?? {}).length;
        const action = await choose(ctx, `Provider ${providerId} — ${provider.name || 'unnamed'}`, [
            { label: `Models (${provider.models?.length ?? 0})…`, value: 'models' },
            { label: 'Edit provider fields…', value: 'fields' },
            { label: 'Fetch models from endpoint…', value: 'fetch' },
            { label: 'Test endpoint…', value: 'test' },
            { label: `Model overrides (${overrideCount})…`, value: 'overrides' },
            { label: 'Edit provider JSON…', value: 'json' },
            { label: 'Duplicate provider…', value: 'duplicate' },
            { label: 'Delete provider…', value: 'delete' },
        ], { search: false });
        if (!action)
            return;
        if (action === 'models') {
            await providerModelsFlow(ctx, providerId);
            continue;
        }
        if (action === 'fields') {
            await editProvider(ctx, providerId, provider, false, doc);
            continue;
        }
        if (action === 'fetch') {
            await fetchModelsFlow(ctx, providerId);
            continue;
        }
        if (action === 'test') {
            await testEndpointFlow(ctx, providerId);
            continue;
        }
        if (action === 'overrides') {
            await overridesFlow(ctx, providerId);
            continue;
        }
        if (action === 'json') {
            await editProviderJsonFlow(ctx, providerId);
            continue;
        }
        if (action === 'duplicate') {
            const id = await inputText(ctx, 'New provider id', providerId, { required: true });
            if (!id)
                continue;
            try {
                validProviderId(id);
            }
            catch (error) {
                ctx.ui.notify(errorMessage(error), 'error');
                continue;
            }
            if (doc.value?.providers?.[id]) {
                ctx.ui.notify(`Provider already exists: ${id}`, 'error');
                continue;
            }
            const candidate = structuredClone(requireModels(doc));
            setProvider(candidate, id, structuredClone(provider));
            try {
                await saveModelsFrom(ctx, doc, candidate, `Provider ${id} duplicated`);
            }
            catch (error) {
                await view(ctx, 'Cannot duplicate provider', errorMessage(error));
            }
            continue;
        }
        if (action === 'delete') {
            const count = provider.models?.length ?? 0;
            if (!await ctx.ui.confirm(`Delete provider ${providerId}?`, `Removes ${count} model${count === 1 ? '' : 's'} and ${overrideCount} override${overrideCount === 1 ? '' : 's'} from models.json. The current session is unchanged; /reload or restart afterward.`))
                return;
            const candidate = structuredClone(requireModels(doc));
            try {
                removeProvider(candidate, providerId);
                await saveModelsFrom(ctx, doc, candidate, `Provider ${providerId} deleted`);
            }
            catch (error) {
                await view(ctx, 'Cannot delete provider', errorMessage(error));
            }
            return;
        }
    }
}
function discoveryFailure(error) {
    if (error instanceof DiscoveryError) {
        return [
            error.message,
            `URL: ${error.url}`,
            ...(error.status ? [`Status: ${error.status}`] : []),
            ...(error.body ? [`Response:\n${error.body}`] : []),
            'The configuration was not changed.',
        ].join('\n\n');
    }
    return `${errorMessage(error)}\n\nThe configuration was not changed.`;
}
async function preflight(ctx, providerId, provider, title) {
    let modelsUrl;
    while (true) {
        let plan;
        try {
            plan = planDiscovery(provider, modelsUrl);
        }
        catch (error) {
            await view(ctx, `${title} — cannot build request`, errorMessage(error));
            return undefined;
        }
        await view(ctx, `${title} — request`, describeDiscoveryPlan(plan));
        const action = await choose(ctx, `${title} — ${providerId}`, [
            { label: plan.commands.length ? 'Run request (executes local auth command)' : 'Run request', value: 'run' },
            { label: 'Change Models URL…', value: 'url' },
            { label: 'Cancel', value: 'cancel' },
        ], { search: false });
        if (!action || action === 'cancel')
            return undefined;
        if (action === 'url') {
            const value = await ctx.ui.input('Models URL', plan.url);
            if (value?.trim())
                modelsUrl = value.trim();
            continue;
        }
        return { plan, ...(modelsUrl ? { modelsUrl } : {}) };
    }
}
export async function testEndpointFlow(ctx, providerId) {
    const doc = await readModels();
    if (doc.error) {
        ctx.ui.notify(doc.error, 'error');
        return;
    }
    const provider = providerOf(requireModels(doc), providerId);
    if (!provider) {
        ctx.ui.notify(`Provider not found: ${providerId}`, 'error');
        return;
    }
    const prepared = await preflight(ctx, providerId, provider, 'Test endpoint');
    if (!prepared)
        return;
    try {
        const result = await working(ctx, 'Testing endpoint…', () => fetchProviderModels(provider, { modelsUrl: prepared.modelsUrl, allowCommands: true }));
        await view(ctx, 'Endpoint test', [
            `OK · HTTP ${result.status} · ${result.elapsedMs} ms`,
            `URL: ${result.url}`,
            `Models: ${result.models.length} · new: ${result.fresh} · configured: ${result.configured}`,
            '',
            ...result.models.slice(0, 40).map(model => `  ${model.id}`),
            ...(result.models.length > 40 ? [`  … ${result.models.length - 40} more`] : []),
        ].join('\n'));
    }
    catch (error) {
        await view(ctx, 'Endpoint test failed', discoveryFailure(error));
    }
}
export async function fetchModelsFlow(ctx, providerId) {
    const base = await readModels();
    if (base.error) {
        ctx.ui.notify(base.error, 'error');
        return;
    }
    const provider = providerOf(requireModels(base), providerId);
    if (!provider) {
        ctx.ui.notify(`Provider not found: ${providerId}`, 'error');
        return;
    }
    const prepared = await preflight(ctx, providerId, provider, 'Fetch models');
    if (!prepared)
        return;
    let result;
    try {
        result = await working(ctx, 'Fetching models…', () => fetchProviderModels(provider, { modelsUrl: prepared.modelsUrl, allowCommands: true }));
    }
    catch (error) {
        await view(ctx, 'Fetch failed', discoveryFailure(error));
        return;
    }
    const configured = new Set((provider.models ?? []).map(model => model.id));
    const selected = await checklist(ctx, `Add models — ${providerId} · ${result.models.length} returned · ${result.fresh} new`, result.models.map(model => ({
        label: model.id,
        value: model,
        detail: [
            configured.has(model.id) ? 'configured' : 'new',
            model.name && model.name !== model.id ? model.name : '',
            model.contextWindow ? `${formatTokens(model.contextWindow)} ctx` : '',
            model.maxTokens ? `${formatTokens(model.maxTokens)} out` : '',
            model.reasoning ? 'reasoning' : '',
            model.input?.includes('image') ? 'image' : '',
        ].filter(Boolean).join(' · '),
        disabled: configured.has(model.id),
    })), 'Space toggles; A selects all new');
    if (!selected?.length) {
        ctx.ui.notify('No models selected. models.json was not changed.', 'info');
        return;
    }
    const added = newDiscoveredModels(provider, selected);
    if (!added.length) {
        ctx.ui.notify('All selected models are already configured.', 'info');
        return;
    }
    await view(ctx, 'Add models — preview', [
        `Provider: ${providerId}`,
        `Adding ${added.length} model${added.length === 1 ? '' : 's'}.`,
        '',
        ...added.map(model => `+ ${model.id} · ${modelDetail(model)}`),
        '',
        'Auto-filled from discovery when available: contextWindow, maxTokens, reasoning, input. Missing fields use 128000 / 16384 / false / text and zero cost.',
        'Writes ~/.pi/agent/models.json with a timestamped backup; changes apply after /reload or restart.',
    ].join('\n'));
    if (!await ctx.ui.confirm(`Add ${added.length} models to ${providerId}?`, 'The current session is unchanged. Run /reload or restart Pi to use the new models.'))
        return;
    const candidate = structuredClone(requireModels(base));
    for (const model of added)
        setModel(candidate, providerId, model);
    try {
        await saveModelsFrom(ctx, base, candidate, `Added ${added.length} model${added.length === 1 ? '' : 's'} to ${providerId}`);
    }
    catch (error) {
        await view(ctx, 'Cannot add models', errorMessage(error));
    }
}
function modelRefs(ctx, models) {
    const refs = new Set();
    for (const [providerId, provider] of providersOf(models ?? {}))
        for (const model of provider.models ?? [])
            refs.add(`${providerId}/${model.id}`);
    try {
        for (const model of ctx.modelRegistry.getModelsOfType('chat'))
            refs.add(`${model.provider}/${model.id}`);
    }
    catch { /* optional registry access */ }
    return [...refs].sort((left, right) => left.localeCompare(right));
}
export async function defaultsFlow(ctx) {
    const base = await readSettings();
    if (base.error) {
        await view(ctx, 'settings.json is invalid', `${base.error}\n\nFile: ${base.path}`);
        return;
    }
    const modelsDoc = await readModels();
    const draft = structuredClone(base.value ?? {});
    const fields = [
        {
            id: 'pick', label: 'Pick from configured models', detail: () => 'choose provider/model',
            edit: async (current) => {
                const refs = modelRefs(ctx, modelsDoc.value);
                if (!refs.length) {
                    ctx.ui.notify('No configured models found. Set provider/model manually.', 'warning');
                    return;
                }
                const selected = await choose(ctx, 'Default model', refs.map(ref => ({ label: `${ref}${ref === `${current.defaultProvider}/${current.defaultModel}` ? ' (current)' : ''}`, value: ref })));
                if (!selected)
                    return;
                const slash = selected.indexOf('/');
                current.defaultProvider = selected.slice(0, slash);
                current.defaultModel = selected.slice(slash + 1);
            },
        },
        {
            id: 'provider', label: 'Default provider', detail: current => current.defaultProvider ?? '(unset)',
            edit: async (current) => { const value = await inputText(ctx, 'Default provider', current.defaultProvider); if (value !== undefined)
                current.defaultProvider = value ?? undefined; },
        },
        {
            id: 'model', label: 'Default model', detail: current => current.defaultModel ?? '(unset)',
            edit: async (current) => { const value = await inputText(ctx, 'Default model', current.defaultModel); if (value !== undefined)
                current.defaultModel = value ?? undefined; },
        },
        {
            id: 'thinking', label: 'Default thinking level', detail: current => current.defaultThinkingLevel ?? THINKING_UNSET,
            edit: async (current) => {
                const value = await chooseValue(ctx, 'Default thinking level', THINKING_LEVELS.map(level => ({ label: level, value: level })), current.defaultThinkingLevel, true);
                if (value === undefined)
                    return;
                if (value === null)
                    delete current.defaultThinkingLevel;
                else
                    current.defaultThinkingLevel = value;
            },
        },
    ];
    await editFields(ctx, 'Defaults — global, new sessions only (blank clears; Esc keeps)', draft, fields, async (saved) => {
        const candidate = structuredClone(base.value ?? {});
        setDefaultSelection(candidate, {
            provider: saved.defaultProvider ?? null,
            model: saved.defaultModel ?? null,
            thinking: saved.defaultThinkingLevel ?? null,
        });
        await saveSettingsFrom(ctx, base, candidate, 'Default model settings saved');
    });
}
export async function enabledFlow(ctx) {
    const base = await readSettings();
    if (base.error) {
        await view(ctx, 'settings.json is invalid', `${base.error}\n\nFile: ${base.path}`);
        return;
    }
    const modelsDoc = await readModels();
    const patterns = [...(readModelDefaults(base.value ?? {}).enabledModels ?? [])];
    while (true) {
        const action = await choose(ctx, `Enabled models — ${patterns.length ? `${patterns.length} pattern${patterns.length === 1 ? '' : 's'}` : 'all models'} · startup/cycling only`, [
            { label: '+ Add from configured models…', value: 'add-models' },
            { label: '+ Add pattern…', value: 'add-pattern' },
            { label: 'Remove pattern…', value: 'remove' },
            { label: 'Clear all patterns', value: 'clear' },
            { label: 'Save changes', value: 'save' },
            { label: 'Cancel', value: 'cancel' },
            ...patterns.map(pattern => ({ label: `  ${pattern}`, value: `pattern:${pattern}` })),
        ]);
        if (!action || action === 'cancel')
            return;
        if (action === 'add-models') {
            const refs = modelRefs(ctx, modelsDoc.value).filter(ref => !patterns.includes(ref));
            if (!refs.length) {
                ctx.ui.notify('Every configured model is already enabled, or no models were found.', 'info');
                continue;
            }
            const selected = await checklist(ctx, 'Enable models', refs.map(ref => ({ label: ref, value: ref })));
            if (selected?.length)
                for (const ref of selected)
                    if (!patterns.includes(ref))
                        patterns.push(ref);
            continue;
        }
        if (action === 'add-pattern') {
            const value = await inputText(ctx, 'Enabled model pattern', undefined, { required: true, placeholder: 'provider/* or provider/model:high' });
            if (value && !patterns.includes(value))
                patterns.push(value);
            continue;
        }
        if (action === 'remove') {
            if (!patterns.length) {
                ctx.ui.notify('No patterns to remove.', 'info');
                continue;
            }
            const selected = await choose(ctx, 'Remove enabled pattern', patterns.map(pattern => ({ label: pattern, value: pattern })));
            if (!selected)
                continue;
            patterns.splice(0, patterns.length, ...patterns.filter(pattern => pattern !== selected));
            continue;
        }
        if (action === 'clear') {
            if (await ctx.ui.confirm('Clear enabled models?', 'Removes every pattern. Pi then treats all available models as enabled for startup selection and cycling.'))
                patterns.length = 0;
            continue;
        }
        if (action === 'save') {
            const candidate = structuredClone(base.value ?? {});
            setEnabledPatterns(candidate, patterns);
            try {
                await saveSettingsFrom(ctx, base, candidate, 'Enabled models saved');
                ctx.ui.notify('Enabled models control startup selection and model cycling; /model still lists every available model.', 'info');
                return;
            }
            catch (error) {
                await view(ctx, 'Cannot save enabled models', errorMessage(error));
            }
            continue;
        }
        // Selecting a pattern row shows a confirmation before removing it.
        if (action.startsWith('pattern:')) {
            const pattern = action.slice('pattern:'.length);
            if (await ctx.ui.confirm(`Remove pattern ${pattern}?`, 'Other matching patterns still keep the model enabled.'))
                patterns.splice(0, patterns.length, ...patterns.filter(item => item !== pattern));
        }
    }
}
export async function runModelAction(ctx, id, kind = 'open') {
    if (id === 'model:raw')
        return editModelsJsonFlow(ctx);
    if (id === 'model:defaults')
        return defaultsFlow(ctx);
    if (id === 'model:enabled')
        return enabledFlow(ctx);
    if (id === 'model:add-override')
        return addOverrideFlow(ctx);
    if (id.startsWith('model:provider:')) {
        const providerId = id.slice('model:provider:'.length);
        if (kind === 'edit') {
            const doc = await readModels();
            if (doc.error) {
                ctx.ui.notify(doc.error, 'error');
                return;
            }
            const provider = providerOf(requireModels(doc), providerId);
            if (!provider) {
                ctx.ui.notify(`Provider not found: ${providerId}`, 'error');
                return;
            }
            await editProvider(ctx, providerId, provider, false, doc);
            return;
        }
        return providerFlow(ctx, providerId);
    }
    if (id.startsWith('model:entry:')) {
        const pair = parseModelRef(id.slice('model:entry:'.length));
        if (!pair)
            return;
        if (kind === 'edit') {
            const doc = await readModels();
            if (doc.error) {
                ctx.ui.notify(doc.error, 'error');
                return;
            }
            const model = providerOf(requireModels(doc), pair[0])?.models?.find(item => item.id === pair[1]);
            if (!model) {
                ctx.ui.notify(`Model not found: ${pair[0]}/${pair[1]}`, 'error');
                return;
            }
            await editModel(ctx, pair[0], model, false, doc);
            return;
        }
        return modelFlow(ctx, pair[0], pair[1]);
    }
    if (id.startsWith('model:overrides:')) {
        return overridesFlow(ctx, id.slice('model:overrides:'.length));
    }
    if (id.startsWith('model:override:')) {
        const pair = parseModelRef(id.slice('model:override:'.length));
        if (pair)
            await overrideFlow(ctx, pair[0], pair[1]);
    }
}
function parseModelRef(value) {
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1)
        return undefined;
    return [value.slice(0, slash), value.slice(slash + 1)];
}
