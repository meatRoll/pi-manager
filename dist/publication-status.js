import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, open } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { BUNDLE_DIR, exportableResources } from './bundle.js';
import { getSettings, getMetadata } from './core.js';
import { absoluteEntries, generationDigest, generationPath } from './generations.js';
import { packageState } from './package-state.js';
import { errorCode } from './errors.js';
import { assertContainedFile, isInside, readJson, RESOURCE_TYPES } from './storage.js';
async function contentDigest(root, signal) {
    signal?.throwIfAborted();
    const hash = createHash('sha256');
    async function visit(path) {
        signal?.throwIfAborted();
        const info = await lstat(path);
        hash.update(JSON.stringify([relative(root, path), info.mode & 0o777, info.isDirectory() ? 'dir' : info.isSymbolicLink() ? 'link' : 'file']));
        if (info.isDirectory())
            for (const name of (await readdir(path)).sort())
                await visit(join(path, name));
        else if (info.isSymbolicLink())
            hash.update(await readlink(path));
        else {
            if (!info.isFile())
                throw new Error('Unsupported resource file');
            const file = await open(path, 'r');
            try {
                for await (const chunk of file.createReadStream({ autoClose: false })) {
                    signal?.throwIfAborted();
                    hash.update(chunk);
                }
            }
            finally {
                await file.close();
            }
        }
    }
    try {
        await lstat(root);
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return 'missing';
        throw error;
    }
    await visit(root);
    signal?.throwIfAborted();
    return hash.digest('hex');
}
/** Read-only comparison, including edits made before opening /manager.
 * Immutable snapshot hashes are cached for this panel invocation only.
 * External local packages remain references, not isolated or tracked copies.
 */
export function createPublicationInspector() {
    const hashes = new Map();
    const snapshotHash = (path, digest, signal) => {
        let value = hashes.get(path);
        if (!value) {
            value = digest(path, signal).catch(error => { hashes.delete(path); throw error; });
            hashes.set(path, value);
        }
        return value;
    };
    return async (current, published, signal) => {
        signal?.throwIfAborted();
        if (published?.profile !== current.profile)
            return 'unpublished';
        try {
            const manifest = await readJson(join(BUNDLE_DIR, 'package.json'));
            if (manifest.piManager.id !== published.id)
                return 'unknown'; // another publisher won a race
            const snapshot = join(BUNDLE_DIR, '.snapshots', published.id);
            const settings = await getSettings(current.profile);
            const saved = await readJson(join(snapshot, 'settings.json'));
            if (JSON.stringify(absoluteEntries(settings, current.root).packages) !== JSON.stringify(saved.packages))
                return 'unpublished';
            const state = packageState(settings);
            const packages = state ? generationPath(current.root, state.active) : current.root;
            const rebase = (path) => {
                for (const [from, to] of [[join(packages, 'npm'), join(snapshot, 'npm')], [join(packages, 'git'), join(snapshot, 'git')], [join(current.root, 'resources'), join(snapshot, 'resources')]]) {
                    if (isInside(from, path))
                        return join(to, relative(from, path));
                }
                return path;
            };
            // Compare exactly what publication exports: user-level discoveries are
            // never written to the snapshot, so they cannot make it look stale.
            const exportable = exportableResources(current.resources);
            for (const type of RESOURCE_TYPES) {
                signal?.throwIfAborted();
                const actual = exportable.filter(resource => resource.type === type).map(resource => rebase(resource.path)).sort();
                const expected = manifest.pi[type].filter(path => path !== join(snapshot, 'extension.mjs')).slice().sort();
                if (JSON.stringify(actual) !== JSON.stringify(expected))
                    return 'unpublished';
            }
            const contexts = [];
            for (const resource of current.resources.filter(resource => resource.type === 'context' && resource.enabled)) {
                await assertContainedFile(join(current.root, 'resources', 'context'), resource.path);
                contexts.push({ name: resource.name, content: await readFile(resource.path, 'utf8') });
            }
            // Inventory is sorted for display; prompt context order comes from metadata.
            const ordered = (await getMetadata(current.profile)).contexts.filter(context => context.enabled).map(context => contexts.find(item => item.name === context.name));
            if (JSON.stringify(ordered) !== JSON.stringify(published.contexts))
                return 'unpublished';
            if (await generationDigest(packages, signal) !== await snapshotHash(snapshot, generationDigest, signal))
                return 'unpublished';
            // Publication copies the full owned resource tree, including disabled
            // resources and skill support files. Those edits are still unpublished.
            const resources = join(current.root, 'resources');
            if (await contentDigest(resources, signal) !== await snapshotHash(join(snapshot, 'resources'), contentDigest, signal))
                return 'unpublished';
            signal?.throwIfAborted();
            return 'published';
        }
        catch {
            signal?.throwIfAborted();
            // A missing file, legacy/malformed snapshot, or a concurrent edit must not
            // be presented as clean. Publishing remains separately validated/locked.
            return 'unknown';
        }
    };
}
