import { mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inventory } from './resources.js';
import { assertProfile, ensureManagerHome, withProfileLock, MANAGER_HOME, RESOURCE_TYPES, safePath, writeJson, writeText, readJson, isInside } from './storage.js';
import { copyOwnedTree, generationPath, absoluteEntries, runPackageWorker } from './generations.js';
import { packageState } from './package-state.js';
import { getSettings, getMetadata } from './core.js';
import { errorCode } from './errors.js';
import { VERSION } from './version.js';
export const BUNDLE_DIR = join(MANAGER_HOME, 'pi-package');
export async function publishedBundle() {
    try {
        const value = await readJson(await safePath(join(BUNDLE_DIR, 'package.json')));
        if (value.piManager?.format !== 1 || value.piManager.managerHome !== MANAGER_HOME)
            throw new Error('Invalid pi-manager export');
        return value.piManager;
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return null;
        throw error;
    }
}
/** A snapshot carries resources this preset declares: package entries (copied or
 * referenced) and files inside the preset. User-level resources that Pi
 * auto-discovers from the home directory are deliberately excluded: Pi loads
 * them itself in every session, so exporting them would only add a live path
 * outside the snapshot that can silently go stale.
 */
export function exportableResources(resources) {
    return resources.filter((resource) => resource.enabled && resource.type !== 'context' && resource.origin !== 'global');
}
/** Publish a detached, immutable package snapshot for the next ordinary Pi start.
 * The live Pi keeps its old files even if a staging profile is edited/deleted.
 * External local packages are intentionally reference-only, not snapshotted.
 */
export async function publishBundle(profile) {
    await ensureManagerHome();
    return profile ? withProfileLock(profile, () => buildBundle(profile)) : buildBundle(null);
}
async function buildBundle(profile) {
    const id = `${Date.now()}-${randomUUID()}`;
    const root = await safePath(join(BUNDLE_DIR, '.snapshots', id));
    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
        const loaded = { format: 1, id, profile, managerHome: MANAGER_HOME, contexts: [] };
        const paths = { extensions: [], skills: [], prompts: [], themes: [] };
        if (profile) {
            const source = await assertProfile(profile);
            const current = await inventory(profile);
            const settings = await getSettings(profile);
            const state = packageState(settings);
            const packages = state ? generationPath(source, state.active) : source;
            for (const kind of ['npm', 'git'])
                await copyOwnedTree(join(packages, kind), join(root, kind));
            await copyOwnedTree(join(source, 'resources'), join(root, 'resources'));
            // Validation never installs or fetches. Refuse an incomplete/missing
            // declaration rather than publishing a misleading empty resource set.
            await writeJson(join(root, 'settings.json'), { packages: absoluteEntries(settings, source).packages });
            await runPackageWorker(root, [], { validate: true, allowMissing: false });
            const rebase = (path) => {
                for (const [from, to] of [[join(packages, 'npm'), join(root, 'npm')], [join(packages, 'git'), join(root, 'git')], [join(source, 'resources'), join(root, 'resources')]]) {
                    if (isInside(from, path))
                        return join(to, relative(from, path));
                }
                return path;
            };
            for (const resource of exportableResources(current.resources)) {
                paths[resource.type].push(rebase(resource.path));
            }
            for (const context of (await getMetadata(profile)).contexts.filter(item => item.enabled)) {
                const path = rebase(join(source, context.path));
                if (!isInside(join(root, 'resources', 'context'), path)
                    || !isInside(await realpath(join(root, 'resources', 'context')), await realpath(path)))
                    throw new Error('Context export escaped its owned directory');
                loaded.contexts.push({ name: context.name, content: await readFile(path, 'utf8') });
            }
        }
        const entry = join(root, 'extension.mjs');
        // An entry unique to each snapshot binds context and paths from the same
        // publication. Never read a newer selection into an already running Pi.
        const implementation = pathToFileURL(fileURLToPath(new URL('./extension.js', import.meta.url))).href;
        await writeText(entry, `import manager from ${JSON.stringify(implementation)};\nexport default function(pi) { return manager(pi, ${JSON.stringify(loaded)}); }\n`);
        paths.extensions.unshift(entry);
        for (const type of RESOURCE_TYPES)
            paths[type] = [...new Set(paths[type])];
        const manifest = { name: 'pi-manager-local-bundle', version: VERSION, private: true, type: 'module', pi: paths, piManager: loaded };
        // Atomic commit point. Nothing that can fail/deletes files follows it.
        await writeJson(join(BUNDLE_DIR, 'package.json'), manifest);
        return loaded;
    }
    catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}
