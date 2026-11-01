import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { MANAGER_HOME, getState, writeJson } from './storage.js';
const exec = promisify(execFile);
export const DEFAULT_PROXY = { mode: 'system' };
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1';
const PROXY_KEYS = [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'npm_config_proxy', 'npm_config_https_proxy',
];
const EXPLICIT_PROXY_KEYS = [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy',
    'NPM_CONFIG_PROXY', 'NPM_CONFIG_HTTPS_PROXY', 'npm_config_proxy', 'npm_config_https_proxy',
];
const first = (...values) => values.map(value => value?.trim()).find((value) => Boolean(value));
/** Accept a bare host:port as HTTP and reject values that would silently become
 * something other than a proxy (paths, query strings, file URLs). */
export function normalizeProxyUrl(value) {
    const trimmed = value.trim();
    if (!trimmed)
        throw new Error('Proxy URL is required');
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    let url;
    try {
        url = new URL(candidate);
    }
    catch {
        throw new Error('Invalid proxy URL. Use http://127.0.0.1:7897 or socks5://127.0.0.1:7897.');
    }
    if (!['http:', 'https:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(url.protocol)) {
        throw new Error(`Unsupported proxy scheme: ${url.protocol.replace(':', '')}. Use http(s) or socks.`);
    }
    if (!url.hostname)
        throw new Error('Proxy URL needs a host');
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash)
        throw new Error('Proxy URL must not include a path, query or fragment');
    return url.toString().replace(/\/$/, '');
}
/** Redact credentials before a proxy URL is shown in a notification or report. */
export function displayProxy(value) {
    try {
        const url = new URL(value);
        if (url.password)
            url.password = '***';
        return url.toString().replace(/\/$/, '');
    }
    catch {
        return value;
    }
}
function normalizeProxyConfig(value) {
    if (!value || typeof value !== 'object')
        return { ...DEFAULT_PROXY };
    const record = value;
    const saved = typeof record.url === 'string' ? (() => { try {
        return normalizeProxyUrl(record.url);
    }
    catch {
        return undefined;
    } })() : undefined;
    if (record.mode === 'none' || record.mode === 'system')
        return { mode: record.mode, ...(saved ? { url: saved } : {}) };
    if (record.mode === 'custom' && saved)
        return { mode: 'custom', url: saved };
    return { ...DEFAULT_PROXY };
}
export async function getProxySettings() {
    return normalizeProxyConfig((await getState()).proxy);
}
export async function setProxySettings(value) {
    if (!['none', 'system', 'custom'].includes(value.mode))
        throw new Error(`Unknown proxy mode: ${String(value.mode)}`);
    const url = value.url ? normalizeProxyUrl(value.url) : undefined;
    if (value.mode === 'custom' && !url)
        throw new Error('Custom proxy mode requires a URL');
    const proxy = { mode: value.mode, ...(url ? { url } : {}) };
    await writeJson(join(MANAGER_HOME, 'state.json'), { ...await getState(), proxy });
    return proxy;
}
function proxyUrl(host, port, scheme) {
    if (!host || !port)
        return undefined;
    const target = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return `${scheme}://${target}:${port}`;
}
/** Parse `scutil --proxy`. macOS is the only platform where reading a GUI/system
 * proxy is both portable across normal installs and reliable without extra libs. */
export function parseMacSystemProxy(output) {
    const values = new Map();
    const exceptions = [];
    let inExceptions = false;
    for (const line of output.split(/\r?\n/)) {
        if (line.includes('ExceptionsList')) {
            inExceptions = true;
            continue;
        }
        if (inExceptions) {
            if (/^\s*}/.test(line)) {
                inExceptions = false;
                continue;
            }
            const item = /^\s*\d+\s*:\s*(.+?)\s*$/.exec(line);
            if (item)
                exceptions.push(item[1]);
            continue;
        }
        const entry = /^\s*([A-Za-z0-9_]+)\s*:\s*(.*?)\s*$/.exec(line);
        if (entry)
            values.set(entry[1], entry[2]);
    }
    const host = (key) => values.get(key)?.trim();
    const enabled = (key) => values.get(key) === '1';
    const http = enabled('HTTPEnable') ? proxyUrl(host('HTTPProxy'), host('HTTPPort'), 'http') : undefined;
    const https = enabled('HTTPSEnable') ? proxyUrl(host('HTTPSProxy'), host('HTTPSPort'), 'https') : undefined;
    const socks = enabled('SOCKSEnable') ? proxyUrl(host('SOCKSProxy'), host('SOCKSPort'), 'socks5') : undefined;
    const all = socks || http || https;
    const fallback = http || https || all;
    if (!http && !https && !all)
        return undefined;
    const noProxy = exceptions
        .map(value => value === '<local>' ? '*.local' : value)
        .filter(Boolean)
        .join(',') || undefined;
    return { http: http || fallback, https: https || http || all, all, noProxy };
}
async function detectSystemProxy() {
    if (process.platform !== 'darwin')
        return undefined;
    try {
        const { stdout } = await exec('scutil', ['--proxy'], { timeout: 2000, maxBuffer: 1024 * 1024 });
        return parseMacSystemProxy(stdout);
    }
    catch {
        return undefined;
    }
}
function proxyFromEnv(env) {
    const http = first(env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy);
    const https = first(env.HTTPS_PROXY, env.https_proxy, env.ALL_PROXY, env.all_proxy);
    const all = first(env.ALL_PROXY, env.all_proxy);
    return { http, https, all, noProxy: first(env.NO_PROXY, env.no_proxy), any: Boolean(http || https || all) };
}
function gitConfigEntries(env) {
    const count = Number.parseInt(env.GIT_CONFIG_COUNT || '', 10);
    const entries = [];
    if (Number.isSafeInteger(count) && count > 0) {
        for (let index = 0; index < count; index += 1) {
            const key = env[`GIT_CONFIG_KEY_${index}`], value = env[`GIT_CONFIG_VALUE_${index}`];
            if (typeof key === 'string' && typeof value === 'string')
                entries.push([key, value]);
        }
    }
    return entries.filter(([key]) => key !== 'http.proxy' && key !== 'https.proxy');
}
/** Git's user config can override http(s)_proxy. Inject duplicate-free command
 * line config so "none" really disables it and "custom" really wins. */
function setGitProxy(env, value) {
    const entries = gitConfigEntries(env);
    entries.push(['http.proxy', value || ''], ['https.proxy', value || '']);
    for (const key of Object.keys(env)) {
        if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key))
            delete env[key];
    }
    env.GIT_CONFIG_COUNT = String(entries.length);
    entries.forEach(([key, entry], index) => {
        env[`GIT_CONFIG_KEY_${index}`] = key;
        env[`GIT_CONFIG_VALUE_${index}`] = entry;
    });
}
/** Pure environment transformation, exported so package/self-update tests can
 * verify the exact child environment without spawning a network process. */
export function applyProxyConfig(base, config, detected) {
    const env = { ...base };
    if (config.mode === 'none') {
        for (const key of PROXY_KEYS)
            delete env[key];
        env.npm_config_proxy = '';
        env.npm_config_https_proxy = '';
        env.NPM_CONFIG_PROXY = '';
        env.NPM_CONFIG_HTTPS_PROXY = '';
        setGitProxy(env, null);
        return env;
    }
    let values;
    let overrideGit = false;
    if (config.mode === 'custom') {
        const url = normalizeProxyUrl(config.url || '');
        values = { http: url, https: url, all: url, noProxy: first(env.NO_PROXY, env.no_proxy) };
        overrideGit = true;
    }
    else {
        const ambient = proxyFromEnv(env);
        if (ambient.any) {
            values = ambient;
            overrideGit = true;
        }
        else if (detected) {
            values = detected;
            overrideGit = true;
        }
        else
            return env;
    }
    for (const key of PROXY_KEYS)
        delete env[key];
    const http = values.http || values.https || values.all;
    const https = values.https || values.http || values.all;
    const all = values.all || http || https;
    const noProxy = values.noProxy || DEFAULT_NO_PROXY;
    if (http) {
        env.HTTP_PROXY = http;
        env.http_proxy = http;
    }
    if (https) {
        env.HTTPS_PROXY = https;
        env.https_proxy = https;
    }
    if (all) {
        env.ALL_PROXY = all;
        env.all_proxy = all;
    }
    if (noProxy) {
        env.NO_PROXY = noProxy;
        env.no_proxy = noProxy;
    }
    const npmProxy = http || https || all;
    if (npmProxy) {
        env.npm_config_proxy = npmProxy;
        env.npm_config_https_proxy = https || npmProxy;
        env.NPM_CONFIG_PROXY = npmProxy;
        env.NPM_CONFIG_HTTPS_PROXY = https || npmProxy;
    }
    if (overrideGit)
        setGitProxy(env, http || https || all || null);
    return env;
}
/** Resolve the environment for one network operation. `overrides` are applied
 * before mode resolution so callers (and tests) can pin or disable proxy vars. */
export async function networkEnvironment(overrides = {}) {
    const base = { ...process.env, ...overrides };
    const config = await getProxySettings();
    if (config.mode !== 'system')
        return applyProxyConfig(base, config);
    const explicit = EXPLICIT_PROXY_KEYS.some(key => Object.hasOwn(overrides, key));
    const ambient = proxyFromEnv(base);
    const detected = explicit || ambient.any ? undefined : await detectSystemProxy();
    return applyProxyConfig(base, config, detected);
}
export async function proxySummary() {
    const config = await getProxySettings();
    const env = await networkEnvironment();
    const effective = first(env.HTTP_PROXY, env.http_proxy, env.HTTPS_PROXY, env.https_proxy, env.ALL_PROXY, env.all_proxy);
    const noProxy = first(env.NO_PROXY, env.no_proxy);
    const label = config.mode === 'none'
        ? 'none'
        : config.mode === 'custom'
            ? `custom ${displayProxy(config.url || '')}`
            : effective ? `system ${displayProxy(effective)}` : 'system (no proxy detected)';
    return { config, env, label, effective, noProxy };
}
export async function proxyReport() {
    const summary = await proxySummary();
    return `proxy:         ${summary.label}${summary.noProxy ? ` · NO_PROXY=${summary.noProxy}` : ''}`;
}
export async function changeProxy(mode, url) {
    if (!mode)
        return proxyReport();
    if (!['none', 'system', 'custom'].includes(mode))
        throw new Error(`Unknown proxy mode: ${mode}. Use none, system or custom.`);
    const current = await getProxySettings();
    const next = mode === 'custom'
        ? { mode: 'custom', url: url || current.url || '' }
        : { mode: mode, ...(current.url ? { url: current.url } : {}) };
    if (mode === 'custom' && !url && !current.url)
        throw new Error('Custom proxy mode requires a URL. See --help.');
    await setProxySettings(next);
    const summary = await proxySummary();
    return `Proxy: ${summary.label}\nApplies to manager package operations, package inspection and self-update; restart is not required.`;
}
