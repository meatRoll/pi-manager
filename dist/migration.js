import { realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { BUNDLE_DIR } from './bundle.js';
import { resolveSourcePath } from './core.js';
import { errorCode, errorMessage } from './errors.js';
import { prepareGeneration, recordGeneration, runPackageWorker, verifyOwnedTree } from './generations.js';
import { PACKAGE_STATE_KEY, isRemoteSource, packageState, sourceOf, withSource } from './package-state.js';
import { getMetadata, getSettings, isInside, readJson, saveSettings, safePath, withProfileLock, } from './storage.js';
export function sourcePiAgentDir() {
    return resolve(resolveSourcePath(process.env.PI_MANAGER_SOURCE_AGENT_DIR || process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')));
}
function normalizeEntry(entry, sourceAgentDir) {
    const source = resolveSourcePath(sourceOf(entry), sourceAgentDir);
    // Pi also accepts bare relative paths (e.g. "my-package"). Resolve every
    // local declaration from its original settings file, never the candidate.
    return withSource(entry, isRemoteSource(source) ? source : resolve(sourceAgentDir, source));
}
async function isManagerBundle(source) {
    if (isRemoteSource(source))
        return false;
    if (source === BUNDLE_DIR)
        return true;
    try {
        return await realpath(source) === await realpath(BUNDLE_DIR);
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return false;
        throw error;
    }
}
/**
 * Import declarations and owned install trees into an empty staging profile.
 * Source settings, credentials, sessions, resources and external local package
 * contents are never moved, edited or deleted. Validation never fetches files
 * or applies extensions; missing installations must be fixed separately.
 */
export async function migratePiPackages(profile, sourceAgentDir = sourcePiAgentDir()) {
    const sourceRoot = await realpath(resolveSourcePath(sourceAgentDir));
    return withProfileLock(profile, async (root) => {
        if (isInside(sourceRoot, root) || isInside(root, sourceRoot))
            throw new Error('Migration source and target directories must not overlap.');
        const current = await getSettings(profile);
        const metadata = await getMetadata(profile);
        if ((current.packages || []).length > 0 || packageState(current) || Object.keys(metadata.disabledPackages || {}).length > 0) {
            throw new Error(`Profile ${profile} already has packages or package history; create an empty staging profile first.`);
        }
        const sourceSettings = await readJson(join(sourceRoot, 'settings.json'));
        const imported = [];
        const skipped = [];
        const externalLocal = [];
        for (const entry of sourceSettings.packages || []) {
            const normalized = normalizeEntry(entry, sourceRoot);
            const source = sourceOf(normalized);
            if (await isManagerBundle(source)) {
                skipped.push(sourceOf(entry));
                continue;
            }
            imported.push(normalized);
            if (!isRemoteSource(source))
                externalLocal.push(source);
        }
        if (imported.length === 0)
            throw new Error('No migratable package declarations found in the source Pi settings.');
        const settings = { ...current, packages: imported };
        if (sourceSettings.npmCommand !== undefined)
            settings.npmCommand = sourceSettings.npmCommand;
        if (sourceSettings.httpProxy !== undefined)
            settings.httpProxy = sourceSettings.httpProxy;
        // prepareGeneration copies source npm/git bytes and cleans up if copying
        // fails. Once it returns, this operation owns candidate cleanup until commit.
        const candidate = await prepareGeneration(root, settings, metadata, sourceRoot);
        let diagnostics = '';
        try {
            for (const kind of ['npm', 'git'])
                await verifyOwnedTree(join(candidate.path, kind));
            const resolved = await runPackageWorker(candidate.path, [], {
                validate: true, allowMissing: false, onLog: result => { diagnostics = result.output.trim().slice(-4096); },
            });
            const bindings = {};
            for (const pkg of resolved.packages) {
                if (!pkg.installedPath)
                    throw new Error(`Migrated package has no installed files: ${pkg.source}`);
                if (isInside(candidate.path, pkg.installedPath))
                    bindings[pkg.source] = pkg.installedPath;
            }
            const state = { format: 1, active: candidate.id, bindings, disabledPackages: {} };
            await recordGeneration(candidate, candidate.settings, metadata, bindings, 'migrate');
            await saveSettings(profile, { ...settings, [PACKAGE_STATE_KEY]: state });
            return { profile, sourceAgentDir: sourceRoot, generation: candidate.id, imported: imported.map(sourceOf), skipped, externalLocal };
        }
        catch (error) {
            await rm(await safePath(candidate.path), { recursive: true, force: true });
            throw new Error(`Package migration failed: ${errorMessage(error)}${diagnostics ? `\n${diagnostics}` : ''}\nSource Pi settings and active staging packages are unchanged; candidate discarded.`);
        }
    });
}
