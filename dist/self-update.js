import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { publishBundle, publishedBundle } from './bundle.js';
const exec = promisify(execFile);
/** Repository root of the running manager: `dist/self-update.js` lives one level down. */
export function managerRoot(moduleUrl = import.meta.url) {
    return dirname(dirname(fileURLToPath(moduleUrl)));
}
async function git(root, args, timeout = 60000) {
    const { stdout } = await exec('git', ['-C', root, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
}
/**
 * Fast-forward the manager checkout from its Git remote and republish so the
 * next Pi start loads the same installation. Refuses dirty trees, detached
 * HEADs and unrelated remotes: an update must never merge, rebase, or pull
 * somebody else's repository into the manager.
 */
export async function selfUpdate(options = {}) {
    const root = resolve(options.root || managerRoot());
    let top;
    try {
        top = await git(root, ['rev-parse', '--show-toplevel']);
    }
    catch {
        throw new Error(`Not a Git checkout: ${root}. Reinstall pi-manager from a clone of its repository to update from Git.`);
    }
    if (resolve(top) !== root)
        throw new Error(`Expected the repository root at ${root}, found ${top}`);
    const origin = await git(root, ['remote', 'get-url', 'origin']).catch(() => '');
    if (!/(?:^|\/|:)pi-manager(?:\.git)?$/.test(origin)) {
        throw new Error(`Refusing to update from ${origin || 'an unknown remote'}; expected the pi-manager repository.`);
    }
    const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === 'HEAD')
        throw new Error('Detached HEAD; check out a branch before updating.');
    const dirty = await git(root, ['status', '--porcelain']);
    if (dirty)
        throw new Error(`Refusing to update a checkout with local changes:\n${dirty}`);
    const before = await git(root, ['rev-parse', '--short', 'HEAD']);
    await git(root, ['fetch', '--prune', 'origin'], 180000);
    await git(root, ['pull', '--ff-only', '--no-rebase'], 180000);
    const after = await git(root, ['rev-parse', '--short', 'HEAD']);
    const result = { root, before, after, changed: before !== after, republished: null };
    if (options.republish !== false) {
        // Republishing re-points the snapshot shim at this checkout, so the next Pi
        // start runs the same installation that was just updated.
        try {
            const published = await publishedBundle();
            if (published?.profile) {
                await publishBundle(published.profile);
                result.republished = published.profile;
            }
        }
        catch (error) {
            result.republishError = error instanceof Error ? error.message : String(error);
        }
    }
    return result;
}
