import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { errorMessage } from './errors.js';
import { resolveSourcePath, packageEntries } from './core.js';
import { getSettings, saveSettings, getMetadata, saveMetadata, withProfileLock, writeText, safePath, writeJson, isInside } from './storage.js';
import { PACKAGE_STATE_KEY, sourceOf, packageState } from './package-state.js';
import { prepareGeneration, recordGeneration, validateGeneration, runPackageWorker, generationPath, absoluteEntries, verifyOwnedTree } from './generations.js';
export function setPackageEnabled(settings, metadata, source, enabled) {
    const entries = settings.packages || [];
    const index = entries.findIndex(entry => sourceOf(entry) === source);
    if (index < 0)
        throw new Error(`Package not configured: ${source}`);
    metadata.disabledPackages ||= {};
    if (enabled) {
        if (Object.hasOwn(metadata.disabledPackages, source)) {
            entries[index] = metadata.disabledPackages[source];
            delete metadata.disabledPackages[source];
        }
    }
    else if (!Object.hasOwn(metadata.disabledPackages, source)) {
        metadata.disabledPackages[source] = structuredClone(entries[index]);
        entries[index] = { source, extensions: [], skills: [], prompts: [], themes: [] };
    }
}
export async function togglePackage(profile, source, enabled) {
    return withProfileLock(profile, async (root) => {
        const settings = await getSettings(profile);
        const meta = await getMetadata(profile);
        const target = resolveSourcePath(source, process.cwd());
        const item = packageEntries(settings, root, meta).find(item => item.source === source || item.identity === target);
        if (!item)
            throw new Error(`Package not configured: ${source}`);
        setPackageEnabled(settings, meta, item.source, enabled);
        const state = packageState(settings);
        if (state) {
            state.disabledPackages = meta.disabledPackages;
            await saveSettings(profile, settings); // package state + filters change atomically
        }
        else {
            await saveMetadata(profile, meta);
            await saveSettings(profile, settings);
        }
    });
}
export function packageArgs(command, source) {
    if (!['add', 'remove', 'update'].includes(command))
        throw new Error('Unsupported package operation');
    if (command !== 'update' && !source)
        throw new Error('Package source is required');
    if (source && ['pi', 'self'].includes(source))
        throw new Error('Pi self-update is not a manager operation');
    if (source && (source.startsWith('-') || /[\0\r\n]/.test(source)))
        throw new Error('Invalid source');
    return [command === 'add' ? 'install' : command, ...(source ? [source] : ['--extensions']), '--no-approve'];
}
async function finishCandidate(candidate, settings, metadata, command, options) {
    // Validation reads manifests/resource paths only, never applies extensions.
    for (const kind of ['npm', 'git'])
        await verifyOwnedTree(join(candidate.path, kind));
    await writeJson(join(candidate.path, 'settings.json'), settings);
    const resolved = await runPackageWorker(candidate.path, [], { ...options, piCommand: undefined, validate: true });
    const bindings = {};
    for (const pkg of resolved.packages) {
        if (!pkg.installedPath)
            throw new Error(`Package has no installed files: ${pkg.source}`);
        if (isInside(candidate.path, pkg.installedPath))
            bindings[pkg.source] = pkg.installedPath;
    }
    await recordGeneration(candidate, settings, metadata, bindings, command);
    return { format: 1, active: candidate.id, bindings, disabledPackages: structuredClone(metadata.disabledPackages || {}), missing: resolved.missing || [] };
}
function checkpoint(settings, state, metadata) {
    return { id: state.active, bindings: state.bindings, packages: absoluteEntries(settings, '').packages,
        disabledPackages: structuredClone(metadata.disabledPackages || {}) };
}
export async function packageOperation(profile, command, source, options = {}) {
    return withProfileLock(profile, async (root) => {
        let target = source && resolveSourcePath(source, options.cwd || process.cwd());
        const settings = await getSettings(profile);
        const metadata = await getMetadata(profile);
        metadata.disabledPackages = Object.fromEntries(Object.entries(metadata.disabledPackages || {}).map(([key, entry]) => {
            const normalized = resolveSourcePath(key, root);
            const restored = typeof entry === 'string' ? normalized : { ...entry, source: normalized };
            return [normalized, restored];
        }));
        if (command !== 'add' && source) {
            const item = packageEntries(settings, root, metadata).find(item => item.source === source || item.identity === target);
            if (!item)
                throw new Error(`Package not configured: ${source}`);
            target = item.identity;
        }
        const args = packageArgs(command, target);
        const logPath = await safePath(join(root, '.operations', `${Date.now()}-${randomUUID()}.log`));
        let output = '', candidate, baseline;
        const record = (result) => {
            output += `${JSON.stringify(result)}\n`;
            if (output.length > 8 * 1024 * 1024)
                output = '[earlier output truncated]\n' + output.slice(-8 * 1024 * 1024);
        };
        const workerOptions = { ...options, onLog: record };
        try {
            let state = packageState(settings);
            let missingBaseline = [];
            if (!state) {
                // Legacy profile-owned npm/git are copied once, never moved or removed.
                baseline = await prepareGeneration(root, settings, metadata);
                state = await finishCandidate(baseline, baseline.settings, metadata, 'baseline', { ...workerOptions, allowMissing: true });
                missingBaseline = state.missing || [];
            }
            const previous = missingBaseline.length ? null : checkpoint(absoluteEntries(settings, root), state, metadata);
            candidate = await prepareGeneration(root, settings, metadata, generationPath(root, state.active));
            const response = await runPackageWorker(candidate.path, args.slice(0, -1), workerOptions);
            if (!response.settings || !Array.isArray(response.settings.packages))
                throw new Error('Package worker returned invalid settings');
            const nextSettings = absoluteEntries(response.settings, candidate.path);
            const kept = new Set((nextSettings.packages || []).map(sourceOf));
            const nextMeta = structuredClone(metadata);
            // Native install replaces an existing package identity in place. Retain
            // its saved filters when switching e.g. npm:foo@1 to npm:foo@2.
            for (const [key, restored] of Object.entries(nextMeta.disabledPackages || {})) {
                if (kept.has(key))
                    continue;
                const index = candidate.settings.packages.findIndex(entry => sourceOf(entry) === key);
                const replacement = command === 'add' ? nextSettings.packages[index] : undefined;
                if (replacement && typeof replacement === 'object'
                    && ['extensions', 'skills', 'prompts', 'themes'].every(type => replacement[type]?.length === 0)) {
                    const renamed = sourceOf(replacement);
                    nextMeta.disabledPackages[renamed] = typeof restored === 'string' ? renamed : { ...restored, source: renamed };
                }
                delete nextMeta.disabledPackages[key];
            }
            const next = await finishCandidate(candidate, nextSettings, nextMeta, command, { ...workerOptions, allowMissing: false });
            if (previous)
                next.previous = previous;
            const committed = { ...settings, packages: nextSettings.packages, [PACKAGE_STATE_KEY]: next };
            // Logs are durable before the commit point. No cleanup/deletion follows
            // commit, so a late log error cannot report a successful switch as failed.
            await writeText(logPath, `${JSON.stringify({ command, args, candidate: candidate.id, previous: previous?.id, missingBaseline, state: 'validated' })}\n${output}`);
            await options.beforeCommit?.(candidate); // fault-injection seam for tests
            await saveSettings(profile, committed); // single atomic reference switch
            return { code: 0, logPath, generation: candidate.id, previous: previous?.id || null, missingBaseline, application: 'next-launch' };
        }
        catch (error) {
            for (const item of [candidate, baseline])
                if (item)
                    await rm(await safePath(item.path), { recursive: true, force: true });
            try {
                await writeText(logPath, `${JSON.stringify({ command, args, state: 'failed', error: errorMessage(error) })}\n${output}`);
            }
            catch { /* Active reference is unchanged even if diagnostics cannot be written. */ }
            throw new Error(`${errorMessage(error)}. Active package generation unchanged; candidate discarded. External script effects are not reversible. Log: ${logPath}`);
        }
    });
}
export async function packageVersions(profile) {
    const settings = await getSettings(profile);
    const state = packageState(settings);
    if (!state)
        return { active: null, previous: null, notice: 'Legacy layout; first successful package operation will create a baseline.' };
    return { active: state.active, previous: state.previous?.id || null };
}
export async function rollbackPackages(profile, options = {}) {
    return withProfileLock(profile, async (root) => {
        const settings = await getSettings(profile);
        const metadata = await getMetadata(profile);
        const state = packageState(settings);
        const previous = state?.previous;
        if (!previous)
            throw new Error('No previous package generation to restore');
        const saved = await validateGeneration(root, previous.id, options);
        if (JSON.stringify(saved.bindings) !== JSON.stringify(previous.bindings))
            throw new Error('Previous package bindings no longer match their saved generation');
        const logPath = join(root, '.operations', `${Date.now()}-${randomUUID()}.log`);
        const next = { format: 1, active: previous.id, bindings: previous.bindings,
            disabledPackages: previous.disabledPackages, previous: checkpoint(settings, state, metadata) };
        await writeText(logPath, JSON.stringify({ command: 'rollback', from: state.active, to: previous.id, state: 'validated' }) + '\n');
        await options.beforeCommit?.();
        await saveSettings(profile, { ...settings, packages: previous.packages, [PACKAGE_STATE_KEY]: next });
        return { generation: previous.id, previous: state.active, logPath, application: 'next-launch' };
    });
}
export async function inspectPackage(source) {
    const target = resolveSourcePath(source);
    if (target.startsWith('/')) {
        const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
        return { kind: 'local', source: target, manifest };
    }
    if (!target.startsWith('npm:')) {
        return { kind: 'git', source: target, notice: 'Git source metadata is only available after download. Review this repository before installing.' };
    }
    return new Promise((resolveInspect, reject) => {
        let stdout = '', stderr = '';
        const child = spawn('npm', ['view', target.slice(4), 'name', 'version', 'description', 'license', 'repository', 'pi', 'peerDependencies', '--json'], {
            env: process.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
        });
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0)
                return reject(new Error(stderr || 'npm metadata lookup failed'));
            try {
                resolveInspect({ kind: 'npm', source, manifest: JSON.parse(stdout) });
            }
            catch (error) {
                reject(error);
            }
        });
    });
}
