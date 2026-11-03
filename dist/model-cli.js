import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './core.js';
import { errorMessage } from './errors.js';
import { plain } from './terminal.js';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_COST, DEFAULT_MAX_TOKENS, THINKING_LEVELS, maskSecret, modelDetail, overrideDetail, parseJsonConfig, providerDetail, providerOf, providersOf, readModelDefaults, readModels, readSettings, removeModel, removeOverride, removeProvider, setDefaultSelection, setEnabledPatterns, setModel, setOverride, setProvider, validateModelsValue, writeModels, writeSettings, } from './model-config.js';
import { describeDiscoveryPlan, fetchProviderModels, newDiscoveredModels, planDiscovery } from './model-discovery.js';
const BOOLEAN_FLAGS = new Set([
    'yes', 'json', 'reveal', 'reasoning', 'no-reasoning', 'auth-header', 'no-auth-header', 'clear',
]);
const VALUE_FLAGS = new Set([
    'name', 'base-url', 'api', 'api-key', 'api-key-env', 'api-key-command', 'header', 'oauth', 'unset',
    'url', 'add', 'thinking', 'id', 'context-window', 'max-tokens', 'input', 'data', 'file',
    'cost-input', 'cost-output', 'cost-read', 'cost-write',
]);
const HELP = `pi-manager models — manage Pi's global model configuration

  pi-manager models                                  Summary and file path
  pi-manager models list [--json] [--reveal]
  pi-manager models show <provider> [model] [--json] [--reveal]
  pi-manager models validate
  pi-manager models edit-json                        Edit models.json in $PI_MANAGER_EDITOR/$EDITOR

  pi-manager models default <provider> <model> [--thinking <level>]
  pi-manager models default --clear [--thinking <level>]
  pi-manager models enabled [list]
  pi-manager models enabled add <pattern...>
  pi-manager models enabled remove <pattern...>
  pi-manager models enabled clear

  pi-manager models provider add <id> [--name <name>] [--base-url <url>] [--api <api>]
      [--api-key <value> | --api-key-env <NAME> | --api-key-command <CMD>]
      [--header name=value]... [--auth-header] [--oauth radius]
  pi-manager models provider update <id> [same flags] [--unset name,baseUrl,apiKey,headers,compat,oauth,authHeader]
  pi-manager models provider remove <id> --yes
  pi-manager models provider test <id> [--url <models-url>] [--json] [--yes]
  pi-manager models provider fetch <id> [--url <models-url>] [--json] [--yes] [--add new|id,id]

  pi-manager models add <provider> --id <id> [--name <name>] [--context-window <n>]
      [--max-tokens <n>] [--reasoning|--no-reasoning] [--input text,image]
      [--cost-input <n> --cost-output <n> --cost-read <n> --cost-write <n>] [--data <json>]
  pi-manager models update <provider> <id> [same flags] [--unset name,api,baseUrl,reasoning,input,contextWindow,maxTokens,cost]
  pi-manager models remove <provider> <id> --yes

  pi-manager models override set <provider> <model-id> (--data <json> | --file <path>)
  pi-manager models override remove <provider> <model-id> --yes

Defaults and enabledModels are written to ~/.pi/agent/settings.json. Provider/model
commands write ~/.pi/agent/models.json. Both use atomic replace, a timestamped
backup under ~/.pi-manager/backups/agent, and refuse if the file changed outside
this manager. modelOverrides accept partial fields and merge at request time.
Use the Models tab in /manager for the structured override form.
`;
function parseFlags(args) {
    const parsed = { positional: [], values: new Map(), booleans: new Set() };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (!arg.startsWith('--') || arg === '--') {
            parsed.positional.push(arg);
            continue;
        }
        const raw = arg.slice(2);
        const equals = raw.indexOf('=');
        const name = equals >= 0 ? raw.slice(0, equals) : raw;
        const inline = equals >= 0 ? raw.slice(equals + 1) : undefined;
        if (BOOLEAN_FLAGS.has(name)) {
            parsed.booleans.add(name);
            continue;
        }
        if (!VALUE_FLAGS.has(name))
            throw new Error(`Unknown option: --${name}. See "pi-manager models --help".`);
        const value = inline ?? args[++index];
        if (value === undefined)
            throw new Error(`--${name} requires a value.`);
        const list = parsed.values.get(name) ?? [];
        list.push(value);
        parsed.values.set(name, list);
    }
    return parsed;
}
const first = (parsed, name) => parsed.values.get(name)?.[0];
const all = (parsed, name) => parsed.values.get(name) ?? [];
const boolean = (parsed, name) => parsed.booleans.has(name);
const print = (text) => console.log(plain(text));
const json = (value) => console.log(JSON.stringify(value, null, 2));
function requireValue(value, label) {
    if (!value)
        throw new Error(`${label} is required. See "pi-manager models --help".`);
    return value;
}
function requireDoc(doc) {
    if (doc.error || doc.value === undefined)
        throw new Error(doc.error ?? `${doc.path} is unavailable`);
    return doc.value;
}
function redactModels(config) {
    const copy = structuredClone(config);
    for (const provider of Object.values(copy.providers ?? {})) {
        if (provider.apiKey)
            provider.apiKey = maskSecret(provider.apiKey);
    }
    return copy;
}
async function summary() {
    const models = await readModels();
    const settings = await readSettings();
    const config = requireDoc(models);
    const defaults = readModelDefaults(settings.value ?? {});
    const providers = providersOf(config);
    print([
        `models.json:   ${models.path}`,
        `settings.json: ${settings.path}`,
        `Providers:     ${providers.length}`,
        `Models:        ${providers.reduce((total, [, provider]) => total + (provider.models?.length ?? 0), 0)}`,
        `Overrides:     ${providers.reduce((total, [, provider]) => total + Object.keys(provider.modelOverrides ?? {}).length, 0)}`,
        `Default:       ${defaults.provider && defaults.model ? `${defaults.provider}/${defaults.model}${defaults.thinking ? ` · ${defaults.thinking}` : ''}` : '(not set)'}`,
        `Enabled:       ${defaults.enabledModels?.length ? `${defaults.enabledModels.length} patterns` : 'all models'}`,
    ].join('\n'));
}
async function list(parsed) {
    const doc = await readModels();
    const config = requireDoc(doc);
    const defaults = readModelDefaults((await readSettings()).value ?? {});
    const reveal = boolean(parsed, 'reveal');
    if (boolean(parsed, 'json')) {
        json({ path: doc.path, defaults, providers: reveal ? config.providers ?? {} : redactModels(config).providers ?? {} });
        return;
    }
    print(`models.json: ${doc.path}`);
    print(`Default: ${defaults.provider && defaults.model ? `${defaults.provider}/${defaults.model}` : '(not set)'}`);
    print(`Enabled: ${defaults.enabledModels?.length ? defaults.enabledModels.join(', ') : 'all models'}`);
    for (const [providerId, provider] of providersOf(config)) {
        print(`\n${provider.name || providerId} (${providerId}) · ${providerDetail(provider)}`);
        if (reveal && provider.apiKey)
            print(`  apiKey: ${provider.apiKey}`);
        for (const model of provider.models ?? [])
            print(`  ${model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id} · ${modelDetail(model)}`);
        for (const [modelId, override] of Object.entries(provider.modelOverrides ?? {}))
            print(`  override ${modelId} · ${overrideDetail(override)}`);
    }
}
async function show(parsed) {
    const providerId = requireValue(parsed.positional[0], 'Provider');
    const modelId = parsed.positional[1];
    const doc = await readModels();
    const provider = providerOf(requireDoc(doc), providerId);
    if (!provider)
        throw new Error(`Provider not found: ${providerId}`);
    const reveal = boolean(parsed, 'reveal');
    if (modelId) {
        const model = provider.models?.find(item => item.id === modelId);
        if (!model)
            throw new Error(`Model not found: ${providerId}/${modelId}`);
        if (boolean(parsed, 'json'))
            json({ provider: providerId, model });
        else
            print(JSON.stringify(model, null, 2));
        return;
    }
    const value = reveal ? provider : { ...provider, ...(provider.apiKey ? { apiKey: maskSecret(provider.apiKey) } : {}) };
    if (boolean(parsed, 'json'))
        json({ provider: providerId, definition: value });
    else
        print(JSON.stringify(value, null, 2));
}
async function editJson() {
    const doc = await readModels();
    const directory = await mkdtemp(join(tmpdir(), 'pi-manager-models-'));
    const path = join(directory, 'models.json');
    try {
        await writeFile(path, doc.raw || '{\n  "providers": {}\n}', { mode: 0o600 });
        const editor = process.env.PI_MANAGER_EDITOR || process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
        const code = await run(editor, [path]);
        if (code !== 0)
            throw new Error(`Editor exited ${code}; models.json was not changed.`);
        const text = await readFile(path, 'utf8');
        if (text.trimEnd() === doc.raw.trimEnd()) {
            print('No changes.');
            return;
        }
        let parsed;
        try {
            parsed = parseJsonConfig(text);
        }
        catch (error) {
            throw new Error(`Invalid JSON: ${errorMessage(error)}`);
        }
        const errors = validateModelsValue(parsed);
        if (errors.length)
            throw new Error(`Invalid models.json:\n${errors.join('\n')}`);
        const result = await writeModels(parsed, { expectedRevision: doc.revision });
        print(`Saved ${result.path}${result.backup ? ` · backup ${result.backup}` : ''}. Run /reload or restart Pi to apply.`);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
}
function parseThinking(value) {
    if (value === undefined)
        return undefined;
    if (!THINKING_LEVELS.includes(value))
        throw new Error(`Unknown thinking level: ${value}`);
    return value;
}
async function defaults(parsed) {
    const doc = await readSettings();
    const candidate = structuredClone(requireDoc(doc));
    const thinking = parseThinking(first(parsed, 'thinking'));
    if (boolean(parsed, 'clear')) {
        setDefaultSelection(candidate, { provider: null, model: null, thinking: thinking ?? null });
    }
    else {
        const provider = requireValue(parsed.positional[0], 'Provider');
        const model = requireValue(parsed.positional[1], 'Model');
        setDefaultSelection(candidate, { provider, model, ...(thinking ? { thinking } : {}) });
    }
    const result = await writeSettings(candidate, { expectedRevision: doc.revision });
    print(`Default model updated${result.backup ? ` · backup ${result.backup}` : ''}. Run /reload or restart Pi for new sessions.`);
}
async function enabled(parsed) {
    const action = parsed.positional[0];
    const doc = await readSettings();
    const candidate = structuredClone(requireDoc(doc));
    if (!action || action === 'list') {
        const patterns = readModelDefaults(candidate).enabledModels ?? [];
        print(patterns.length ? patterns.join('\n') : 'all models (no enabledModels patterns)');
        return;
    }
    const patterns = [...(readModelDefaults(candidate).enabledModels ?? [])];
    if (action === 'add') {
        const values = parsed.positional.slice(1);
        if (!values.length)
            throw new Error('At least one pattern is required.');
        setEnabledPatterns(candidate, [...patterns, ...values]);
    }
    else if (action === 'remove') {
        const values = new Set(parsed.positional.slice(1));
        if (!values.size)
            throw new Error('At least one pattern is required.');
        setEnabledPatterns(candidate, patterns.filter(pattern => !values.has(pattern)));
    }
    else if (action === 'clear') {
        setEnabledPatterns(candidate, []);
    }
    else
        throw new Error(`Unknown enabled action: ${action}`);
    const result = await writeSettings(candidate, { expectedRevision: doc.revision });
    print(`Enabled models updated${result.backup ? ` · backup ${result.backup}` : ''}. Run /reload or restart Pi.`);
}
function parseHeaders(values) {
    const headers = {};
    for (const value of values) {
        const equals = value.indexOf('=');
        if (equals <= 0)
            throw new Error(`Invalid --header value: ${value}. Use name=value.`);
        headers[value.slice(0, equals)] = value.slice(equals + 1);
    }
    return headers;
}
function providerFromFlags(parsed, existing) {
    const provider = structuredClone(existing ?? {});
    const unset = new Set((first(parsed, 'unset') ?? '').split(',').map(value => value.trim()).filter(Boolean));
    for (const key of unset)
        delete provider[key];
    const name = first(parsed, 'name');
    if (name !== undefined) {
        if (name)
            provider.name = name;
        else
            delete provider.name;
    }
    const baseUrl = first(parsed, 'base-url');
    if (baseUrl !== undefined) {
        if (baseUrl)
            provider.baseUrl = baseUrl;
        else
            delete provider.baseUrl;
    }
    const api = first(parsed, 'api');
    if (api !== undefined) {
        if (api)
            provider.api = api;
        else
            delete provider.api;
    }
    const oauth = first(parsed, 'oauth');
    if (oauth !== undefined) {
        if (oauth)
            provider.oauth = oauth;
        else
            delete provider.oauth;
    }
    const keyFlags = [first(parsed, 'api-key') !== undefined, first(parsed, 'api-key-env') !== undefined, first(parsed, 'api-key-command') !== undefined].filter(Boolean).length;
    if (keyFlags > 1)
        throw new Error('Use only one of --api-key, --api-key-env, --api-key-command.');
    if (first(parsed, 'api-key') !== undefined)
        provider.apiKey = first(parsed, 'api-key');
    if (first(parsed, 'api-key-env') !== undefined) {
        const value = requireValue(first(parsed, 'api-key-env'), 'Environment variable name');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
            throw new Error(`Invalid environment variable name: ${value}`);
        provider.apiKey = `$${value}`;
    }
    if (first(parsed, 'api-key-command') !== undefined)
        provider.apiKey = `!${requireValue(first(parsed, 'api-key-command'), 'Command').replace(/^!/, '')}`;
    if (boolean(parsed, 'auth-header'))
        provider.authHeader = true;
    if (boolean(parsed, 'no-auth-header'))
        delete provider.authHeader;
    const headers = parseHeaders(all(parsed, 'header'));
    if (Object.keys(headers).length)
        provider.headers = { ...(provider.headers ?? {}), ...headers };
    return provider;
}
async function provider(parsed) {
    const action = parsed.positional[0];
    const doc = await readModels();
    const config = requireDoc(doc);
    const providerId = requireValue(parsed.positional[1], 'Provider id');
    if (action === 'add' || action === 'update') {
        const existing = providerOf(config, providerId);
        if (action === 'add' && existing)
            throw new Error(`Provider already exists: ${providerId}`);
        if (action === 'update' && !existing)
            throw new Error(`Provider not found: ${providerId}`);
        const candidate = structuredClone(config);
        setProvider(candidate, providerId, providerFromFlags(parsed, existing));
        const errors = validateModelsValue(candidate);
        if (errors.length)
            throw new Error(errors.join('\n'));
        const result = await writeModels(candidate, { expectedRevision: doc.revision });
        print(`Provider ${providerId} ${action === 'add' ? 'added' : 'updated'}${result.backup ? ` · backup ${result.backup}` : ''}. Run /reload or restart Pi.`);
        return;
    }
    if (action === 'remove') {
        if (!boolean(parsed, 'yes'))
            throw new Error('Pass --yes to remove a provider.');
        const candidate = structuredClone(config);
        removeProvider(candidate, providerId);
        const result = await writeModels(candidate, { expectedRevision: doc.revision });
        print(`Provider ${providerId} removed${result.backup ? ` · backup ${result.backup}` : ''}. Run /reload or restart Pi.`);
        return;
    }
    if (action === 'test' || action === 'fetch') {
        const existing = providerOf(config, providerId);
        if (!existing)
            throw new Error(`Provider not found: ${providerId}`);
        const modelsUrl = first(parsed, 'url');
        const plan = planDiscovery(existing, modelsUrl);
        if (!boolean(parsed, 'json'))
            print(describeDiscoveryPlan(plan));
        if (plan.commands.length && !boolean(parsed, 'yes')) {
            throw new Error([
                'Auth uses local commands:',
                ...plan.commands.map(item => `  ${item.label}: ${item.command}`),
                'Pass --yes to run them.',
            ].join('\n'));
        }
        const result = await fetchProviderModels(existing, { modelsUrl, allowCommands: boolean(parsed, 'yes') });
        if (action === 'test') {
            if (boolean(parsed, 'json'))
                json(result);
            else {
                print(`\nOK · HTTP ${result.status} · ${result.elapsedMs} ms · ${result.models.length} models · ${result.fresh} new · ${result.configured} configured`);
                for (const model of result.models.slice(0, 40))
                    print(`  ${model.id}`);
                if (result.models.length > 40)
                    print(`  … ${result.models.length - 40} more`);
            }
            return;
        }
        const spec = first(parsed, 'add');
        if (spec === undefined) {
            if (boolean(parsed, 'json'))
                json(result);
            else {
                print(`\nFound ${result.models.length} models · ${result.fresh} new · ${result.configured} configured`);
                const configured = new Set((existing.models ?? []).map(model => model.id));
                for (const model of result.models)
                    print(`${configured.has(model.id) ? '=' : '+'} ${model.id}`);
            }
            return;
        }
        const configured = new Set((existing.models ?? []).map(model => model.id));
        const wanted = spec === 'new'
            ? new Set(result.models.filter(model => !configured.has(model.id)).map(model => model.id))
            : new Set(spec.split(',').map(value => value.trim()).filter(Boolean));
        const selected = result.models.filter(model => wanted.has(model.id) && !configured.has(model.id));
        if (!selected.length) {
            print('Nothing new to add.');
            return;
        }
        const added = newDiscoveredModels(existing, selected);
        const candidate = structuredClone(config);
        for (const model of added)
            setModel(candidate, providerId, model);
        const write = await writeModels(candidate, { expectedRevision: doc.revision });
        if (boolean(parsed, 'json'))
            json({ ...result, added, backup: write.backup });
        else
            print(`Added ${added.length} model${added.length === 1 ? '' : 's'} to ${providerId}${write.backup ? ` · backup ${write.backup}` : ''}. Run /reload or restart Pi.`);
        return;
    }
    throw new Error(`Unknown provider action: ${action}`);
}
function positiveNumber(value, label, integer) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || (integer && (!Number.isSafeInteger(number) || number <= 0)))
        throw new Error(`Invalid ${label}: ${value}`);
    return number;
}
function modelFromFlags(parsed, existing) {
    const id = existing?.id ?? requireValue(first(parsed, 'id'), 'Model id');
    const model = existing ? structuredClone(existing) : {
        id, reasoning: false, input: ['text'], contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS, cost: { ...DEFAULT_COST },
    };
    const unset = new Set((first(parsed, 'unset') ?? '').split(',').map(value => value.trim()).filter(Boolean));
    for (const key of unset)
        delete model[key];
    const name = first(parsed, 'name');
    if (name !== undefined) {
        if (name)
            model.name = name;
        else
            delete model.name;
    }
    const api = first(parsed, 'api');
    if (api !== undefined) {
        if (api)
            model.api = api;
        else
            delete model.api;
    }
    const baseUrl = first(parsed, 'base-url');
    if (baseUrl !== undefined) {
        if (baseUrl)
            model.baseUrl = baseUrl;
        else
            delete model.baseUrl;
    }
    if (boolean(parsed, 'reasoning'))
        model.reasoning = true;
    if (boolean(parsed, 'no-reasoning'))
        model.reasoning = false;
    const input = first(parsed, 'input');
    if (input !== undefined) {
        const values = input.split(',').map(value => value.trim()).filter(Boolean);
        if (!values.length || values.some(value => value !== 'text' && value !== 'image'))
            throw new Error('--input accepts text,image (comma-separated).');
        model.input = [...new Set(values)];
    }
    const contextWindow = first(parsed, 'context-window');
    if (contextWindow !== undefined)
        model.contextWindow = positiveNumber(contextWindow, 'context window', true);
    const maxTokens = first(parsed, 'max-tokens');
    if (maxTokens !== undefined)
        model.maxTokens = positiveNumber(maxTokens, 'max tokens', true);
    const costs = [
        ['cost-input', 'input'], ['cost-output', 'output'], ['cost-read', 'cacheRead'], ['cost-write', 'cacheWrite'],
    ];
    for (const [flag, key] of costs) {
        const value = first(parsed, flag);
        if (value === undefined)
            continue;
        model.cost ??= {};
        model.cost[key] = positiveNumber(value, flag, false);
    }
    if (model.cost) {
        model.cost.input ??= 0;
        model.cost.output ??= 0;
        model.cost.cacheRead ??= 0;
        model.cost.cacheWrite ??= 0;
    }
    const data = first(parsed, 'data');
    if (data !== undefined) {
        let parsedData;
        try {
            parsedData = parseJsonConfig(data);
        }
        catch (error) {
            throw new Error(`Invalid --data JSON: ${errorMessage(error)}`);
        }
        if (!parsedData || typeof parsedData !== 'object' || Array.isArray(parsedData))
            throw new Error('--data must be a JSON object.');
        Object.assign(model, parsedData);
        if (existing && model.id !== existing.id)
            throw new Error('--data cannot change the model id. Add a duplicate instead.');
    }
    if (typeof model.id !== 'string' || !model.id.trim())
        throw new Error('Model id cannot be removed.');
    if (model.contextWindow && model.maxTokens && model.maxTokens > model.contextWindow)
        model.maxTokens = model.contextWindow;
    return model;
}
async function model(action, parsed) {
    const doc = await readModels();
    const config = requireDoc(doc);
    const providerId = requireValue(parsed.positional[0], 'Provider');
    const provider = providerOf(config, providerId);
    if (!provider)
        throw new Error(`Provider not found: ${providerId}`);
    if (action === 'add') {
        const value = modelFromFlags(parsed);
        if (provider.models?.some(item => item.id === value.id))
            throw new Error(`Model already exists: ${providerId}/${value.id}`);
        const candidate = structuredClone(config);
        setModel(candidate, providerId, value);
        const errors = validateModelsValue(candidate);
        if (errors.length)
            throw new Error(errors.join('\n'));
        const result = await writeModels(candidate, { expectedRevision: doc.revision });
        print(`Model ${providerId}/${value.id} added${result.backup ? ` · backup ${result.backup}` : ''}. Run /reload or restart Pi.`);
        return;
    }
    if (action === 'update') {
        const modelId = requireValue(parsed.positional[1], 'Model id');
        const existing = provider.models?.find(item => item.id === modelId);
        if (!existing)
            throw new Error(`Model not found: ${providerId}/${modelId}`);
        const value = modelFromFlags(parsed, existing);
        const candidate = structuredClone(config);
        setModel(candidate, providerId, value);
        const errors = validateModelsValue(candidate);
        if (errors.length)
            throw new Error(errors.join('\n'));
        const result = await writeModels(candidate, { expectedRevision: doc.revision });
        print(`Model ${providerId}/${modelId} updated${result.backup ? ` · backup ${result.backup}` : ''}. Run /reload or restart Pi.`);
        return;
    }
    if (action === 'remove') {
        if (!boolean(parsed, 'yes'))
            throw new Error('Pass --yes to remove a model.');
        const modelId = requireValue(parsed.positional[1], 'Model id');
        const candidate = structuredClone(config);
        removeModel(candidate, providerId, modelId);
        const result = await writeModels(candidate, { expectedRevision: doc.revision });
        print(`Model ${providerId}/${modelId} removed${result.backup ? ` · backup ${result.backup}` : ''}. Run /reload or restart Pi.`);
        return;
    }
    throw new Error(`Unknown model action: ${action}`);
}
async function override(parsed) {
    const action = parsed.positional[0];
    const doc = await readModels();
    const config = requireDoc(doc);
    const providerId = requireValue(parsed.positional[1], 'Provider');
    const modelId = requireValue(parsed.positional[2], 'Model id');
    if (action === 'set') {
        const data = first(parsed, 'data');
        const file = first(parsed, 'file');
        if ((data === undefined) === (file === undefined))
            throw new Error('Pass exactly one of --data <json> or --file <path>.');
        const text = data ?? await readFile(requireValue(file, 'File'), 'utf8');
        let value;
        try {
            value = parseJsonConfig(text);
        }
        catch (error) {
            throw new Error(`Invalid override JSON: ${errorMessage(error)}`);
        }
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('Override must be a JSON object.');
        const candidate = structuredClone(config);
        const current = providerOf(candidate, providerId)?.modelOverrides?.[modelId] ?? {};
        setOverride(candidate, providerId, modelId, { ...current, ...value });
        const errors = validateModelsValue(candidate);
        if (errors.length)
            throw new Error(errors.join('\n'));
        const result = await writeModels(candidate, { expectedRevision: doc.revision });
        print(`Override ${providerId}/${modelId} saved${result.backup ? ` · backup ${result.backup}` : ''}. Run /reload or restart Pi.`);
        return;
    }
    if (action === 'remove') {
        if (!boolean(parsed, 'yes'))
            throw new Error('Pass --yes to remove a model override.');
        const candidate = structuredClone(config);
        removeOverride(candidate, providerId, modelId);
        const result = await writeModels(candidate, { expectedRevision: doc.revision });
        print(`Override ${providerId}/${modelId} removed${result.backup ? ` · backup ${result.backup}` : ''}. Run /reload or restart Pi.`);
        return;
    }
    throw new Error(`Unknown override action: ${action}`);
}
export async function runModelsCommand(args) {
    if (!args.length) {
        await summary();
        return;
    }
    const [command, ...raw] = args;
    if (command === '--help' || command === '-h' || command === 'help') {
        print(HELP);
        return;
    }
    const parsed = parseFlags(raw);
    if (command === 'list') {
        await list(parsed);
        return;
    }
    if (command === 'show') {
        await show(parsed);
        return;
    }
    if (command === 'validate') {
        const models = await readModels();
        const settings = await readSettings();
        const errors = [
            ...(models.error ? [`models.json:\n${models.error}`] : []),
            ...(settings.error ? [`settings.json:\n${settings.error}`] : []),
        ];
        if (errors.length)
            throw new Error(errors.join('\n\n'));
        print(`models.json: OK (${models.path})\nsettings.json: OK (${settings.path})`);
        return;
    }
    if (command === 'edit-json') {
        await editJson();
        return;
    }
    if (command === 'default') {
        await defaults(parsed);
        return;
    }
    if (command === 'enabled') {
        await enabled(parsed);
        return;
    }
    if (command === 'provider') {
        await provider(parsed);
        return;
    }
    if (command === 'add' || command === 'update' || command === 'remove') {
        await model(command, parsed);
        return;
    }
    if (command === 'override') {
        await override(parsed);
        return;
    }
    throw new Error(`Unknown models command: ${command}. See "pi-manager models --help".`);
}
