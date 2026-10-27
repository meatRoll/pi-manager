import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { join, basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { errorCode } from './errors.js';
import { profileEnv, packageEntries } from './core.js';
import { packageState, isRemoteSource } from './package-state.js';
import { packageDisplayName } from './package-label.js';
import { localPackageOrigin } from './local-git.js';
import { RESOURCE_TYPES, assertProfile, getSettings, saveSettings, getMetadata, saveMetadata, validName, safePath, writeText, withProfileLock, isInside, assertContainedFile, } from './storage.js';
const worker = fileURLToPath(new URL('./sdk-worker.js', import.meta.url));
export function parseResourceType(value) {
    if (value === 'context' || RESOURCE_TYPES.some(type => type === value))
        return value;
    throw new Error(`Unknown resource type: ${value}`);
}
export function resourceId(type, path, source) {
    return createHash('sha256').update(`${type}\0${source}\0${path}`).digest('hex').slice(0, 12);
}
/** Pi reports package resources as `origin: 'package'` and everything else as
 * `top-level`. Among top-level entries, `source: 'auto'` marks files Pi found in
 * user-level directories (for example ~/.agents/skills) that this preset never
 * declared; those are listed read-only and never exported, because Pi discovers
 * them on its own in every session.
 */
export function resourceOrigin(metadata) {
    if (metadata.origin === 'package')
        return 'package';
    return metadata.source === 'auto' ? 'global' : 'standalone';
}
export function originLabel(origin) {
    return origin === 'global' ? 'user-level' : origin;
}
export async function inventory(profile, options = {}) {
    options.signal?.throwIfAborted();
    const root = await assertProfile(profile);
    const settings = await getSettings(profile);
    const metadata = await getMetadata(profile);
    options.signal?.throwIfAborted();
    const snapshot = await new Promise((resolveInventory, reject) => {
        let stdout = '', stderr = '', failure;
        const child = spawn(process.execPath, [worker], {
            cwd: root, env: { ...profileEnv(profile), PI_OFFLINE: '1' },
            stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, signal: options.signal,
        });
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', error => { failure = error; });
        child.on('close', code => {
            if (failure)
                return reject(failure);
            if (code !== 0)
                return reject(new Error(`Resource discovery failed: ${stderr.trim()}`));
            try {
                resolveInventory(JSON.parse(stdout));
            }
            catch {
                reject(new Error(`Invalid Pi inventory: ${stderr || stdout.slice(0, 200)}`));
            }
        });
    });
    options.signal?.throwIfAborted();
    const bindings = packageState(settings)?.bindings || {};
    const logicalSource = (source) => Object.entries(bindings).find(([, path]) => path === source)?.[0] || source;
    const packages = [];
    for (const item of packageEntries(settings, root, metadata)) {
        options.signal?.throwIfAborted();
        const installed = snapshot.packages.find(pkg => logicalSource(pkg.source) === item.source);
        const origin = !isRemoteSource(item.source) && installed?.installedPath
            ? await localPackageOrigin(installed.installedPath, options.signal) : undefined;
        packages.push({ ...item, ...installed, source: item.source, enabled: item.enabled,
            displayName: packageDisplayName(item.source, installed?.name, origin) });
    }
    options.signal?.throwIfAborted();
    const resources = [];
    for (const type of RESOURCE_TYPES) {
        for (const resource of snapshot.paths[type] || []) {
            const { path, enabled, metadata: sourceMeta } = resource;
            const origin = resourceOrigin(sourceMeta);
            const source = logicalSource(sourceMeta.source);
            const name = basename(path) === 'SKILL.md' ? basename(dirname(path)) : basename(path);
            const pkg = packages.find(item => item.source === source);
            const entryPath = sourceMeta.packageRoot ? relative(sourceMeta.packageRoot, path).split('\\').join('/') || '.' : name;
            const displayName = type === 'extensions' && origin === 'package' ? `${pkg?.displayName || packageDisplayName(source)} · ${entryPath}` : name;
            resources.push({
                id: resourceId(type, path, source), type, path, name, displayName,
                enabled, origin, source, packageRoot: sourceMeta.packageRoot,
                owned: origin === 'standalone' && isInside(join(root, 'resources', type), path),
            });
        }
    }
    for (const context of metadata.contexts || []) {
        const path = join(root, context.path);
        resources.push({ id: resourceId('context', path, 'manager'), type: 'context', path, name: context.name, displayName: context.name,
            enabled: context.enabled, origin: 'standalone', source: 'manager', owned: true });
    }
    return { profile, root, packages, resources: resources.sort((a, b) => a.type.localeCompare(b.type) || a.displayName.localeCompare(b.displayName)) };
}
async function findResource(profile, id) {
    const current = await inventory(profile);
    const resource = current.resources.find(item => item.id === id);
    if (!resource)
        throw new Error(`Resource not found: ${id}. Refresh the resource list.`);
    return { current, resource };
}
export async function previewResource(profile, id) {
    const { current, resource } = await findResource(profile, id);
    let path = resource.path;
    if (resource.owned)
        await assertContainedFile(join(current.root, 'resources'), path);
    if ((await lstat(path)).isDirectory()) {
        // Extension directory entries point at their entry module.
        try {
            await lstat(join(path, 'index.ts'));
            path = join(path, 'index.ts');
        }
        catch {
            path = join(path, 'index.js');
        }
    }
    const { open } = await import('node:fs/promises');
    const file = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(128 * 1024 + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        const truncated = bytesRead > 128 * 1024;
        return { ...resource, text: buffer.subarray(0, Math.min(bytesRead, 128 * 1024)).toString('utf8'), truncated };
    }
    finally {
        await file.close();
    }
}
export async function toggleResource(profile, id, enabled) {
    return withProfileLock(profile, async (root) => {
        const { resource } = await findResource(profile, id);
        if (resource.origin === 'global')
            throw new Error('User-level resources are discovered by Pi itself and cannot be toggled from a staging preset.');
        if (resource.type === 'context') {
            const meta = await getMetadata(profile);
            const item = meta.contexts.find(item => join(root, item.path) === resource.path);
            if (!item)
                throw new Error('Context is no longer configured');
            item.enabled = enabled;
            await saveMetadata(profile, meta);
            return;
        }
        const settings = await getSettings(profile);
        let patterns, baseDir;
        if (resource.origin === 'package') {
            const entries = settings.packages || [];
            const index = entries.findIndex(entry => (typeof entry === 'string' ? entry : entry.source) === resource.source);
            if (index < 0)
                throw new Error('Package source is no longer configured');
            const old = entries[index];
            const entry = typeof old === 'string' ? { source: old } : { ...old };
            if (Object.hasOwn((await getMetadata(profile)).disabledPackages || {}, entry.source))
                throw new Error(`Package is disabled: ${resource.source}. Enable the package first (Packages tab), then toggle this resource.`);
            patterns = [...entry[resource.type] || []];
            // [] means none, unlike an absent filter. Retain that selection when
            // enabling a single file rather than accidentally enabling its siblings.
            if (entry[resource.type]?.length === 0)
                patterns = ['!**/*'];
            baseDir = resource.packageRoot;
            if (!baseDir)
                throw new Error('Pi did not report the package root');
            const target = relative(baseDir, resource.path).split('\\').join('/');
            patterns = patterns.filter(pattern => pattern !== `+${target}` && pattern !== `-${target}`);
            entry[resource.type] = [...patterns, `${enabled ? '+' : '-'}${target}`];
            entries[index] = entry;
        }
        else {
            patterns = [...settings[resource.type] || []].filter(pattern => pattern !== `+${resource.path}` && pattern !== `-${resource.path}`);
            settings[resource.type] = [...patterns, `${enabled ? '+' : '-'}${resource.path}`];
        }
        await saveSettings(profile, settings);
    });
}
export async function importResource(profile, type, source, name) {
    if (![...RESOURCE_TYPES, 'context'].includes(type))
        throw new Error(`Unknown resource type: ${type}`);
    return withProfileLock(profile, async (root) => {
        const input = resolve(source);
        const stat = await lstat(input);
        if (stat.isSymbolicLink())
            throw new Error('Import symlink targets explicitly, not symlinks');
        name = validName(name || (type === 'skills' ? basename(input) : basename(input).replace(/\.[^.]+$/, '')));
        if (type === 'skills') {
            if (!stat.isDirectory())
                throw new Error('Import a skill directory containing SKILL.md');
            await lstat(join(input, 'SKILL.md'));
        }
        else if (type === 'extensions' && stat.isDirectory()) {
            try {
                await lstat(join(input, 'index.ts'));
            }
            catch {
                await lstat(join(input, 'index.js'));
            }
        }
        else {
            if (!stat.isFile())
                throw new Error('This resource must be a regular file');
            const valid = type === 'themes' ? /\.json$/i : type === 'extensions' ? /\.[cm]?[jt]s$/i : /\.md$/i;
            if (!valid.test(input))
                throw new Error(`Invalid file type for ${type}`);
            if (type === 'themes')
                JSON.parse(await readFile(input, 'utf8'));
        }
        const extension = stat.isDirectory() ? '' : type === 'themes' ? '.json' : type === 'extensions' ? input.slice(input.lastIndexOf('.')) : '.md';
        const destination = await safePath(join(root, 'resources', type, name + extension));
        try {
            await lstat(destination);
            throw new Error(`Resource already exists: ${name}`);
        }
        catch (error) {
            if (errorCode(error) !== 'ENOENT')
                throw error;
        }
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        try {
            await cp(input, destination, { recursive: stat.isDirectory(), errorOnExist: true, force: false, verbatimSymlinks: true,
                filter: async (path) => { if ((await lstat(path)).isSymbolicLink())
                    throw new Error(`Symlink import refused: ${path}`); return true; },
            });
            const path = relative(root, destination);
            if (type === 'context') {
                const meta = await getMetadata(profile);
                meta.contexts ||= [];
                meta.contexts.push({ name, path, enabled: true });
                await saveMetadata(profile, meta);
            }
            else {
                const settings = await getSettings(profile);
                settings[type] = [...settings[type] || [], path];
                await saveSettings(profile, settings);
            }
            return destination;
        }
        catch (error) {
            await rm(destination, { recursive: true, force: true });
            throw error;
        }
    });
}
export async function createContext(profile, name, text = '') {
    validName(name);
    return withProfileLock(profile, async (root) => {
        const meta = await getMetadata(profile);
        meta.contexts ||= [];
        if (meta.contexts.some(context => context.name === name))
            throw new Error(`Context already exists: ${name}`);
        const path = `resources/context/${name}.md`;
        await writeText(join(root, path), text);
        meta.contexts.push({ name, path, enabled: true });
        await saveMetadata(profile, meta);
        return join(root, path);
    });
}
export async function writeResource(profile, id, text) {
    return withProfileLock(profile, async (root) => {
        const { resource } = await findResource(profile, id);
        if (!resource.owned)
            throw new Error('External/package resources are read-only. Import a copy to edit.');
        let path = await assertContainedFile(join(root, 'resources'), resource.path);
        if ((await lstat(path)).isDirectory()) {
            try {
                await lstat(join(path, 'index.ts'));
                path = join(path, 'index.ts');
            }
            catch {
                path = join(path, 'index.js');
            }
            await assertContainedFile(join(root, 'resources'), path);
        }
        if (resource.type === 'themes')
            JSON.parse(text);
        await writeText(path, text);
    });
}
export async function removeResource(profile, id) {
    return withProfileLock(profile, async (root) => {
        const { resource } = await findResource(profile, id);
        if (!resource.owned)
            throw new Error('Cannot delete package/external resources. Disable them or remove their package.');
        let target = resource.path;
        if (resource.type === 'skills' && basename(target) === 'SKILL.md')
            target = dirname(target);
        await assertContainedFile(join(root, 'resources', resource.type), target);
        await safePath(target);
        if (resource.type === 'context') {
            const meta = await getMetadata(profile);
            meta.contexts = meta.contexts.filter(item => join(root, item.path) !== target);
            await saveMetadata(profile, meta);
        }
        else {
            const settings = await getSettings(profile);
            settings[resource.type] = (settings[resource.type] || []).filter(pattern => {
                const value = /^[+!-]/.test(pattern) ? pattern.slice(1) : pattern;
                const absolute = resolve(root, value);
                return absolute !== target && absolute !== resource.path;
            });
            await saveSettings(profile, settings);
        }
        await rm(target, { recursive: true, force: true });
    });
}
