import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inventory } from './resources.js';
import { assertProfile, ensureManagerHome, withProfileLock, MANAGER_HOME, PUBLISH_DIR, RESOURCE_TYPES, safePath, writeJson, readJson, isInside } from './storage.js';
import { copyOwnedTree, generationPath, absoluteEntries, runPackageWorker } from './generations.js';
import { packageState } from './package-state.js';
import { getSettings, getMetadata } from './core.js';
import { errorCode } from './errors.js';
import { VERSION } from './version.js';
import type { PiResourceType, Resource, ResourceType } from './types.js';

export const BUNDLE_DIR = PUBLISH_DIR;
export interface LoadedBundle {
  format: 1;
  id: string;
  profile: string | null;
  managerHome: string;
  contexts: { name: string; content: string }[];
}
interface BundleManifest {
  name: string;
  version: string;
  private: true;
  type: 'module';
  pi: Record<Exclude<ResourceType, 'context'>, string[]>;
  piManager: LoadedBundle;
}

/** Startup binding for the manager package itself. Any unreadable or malformed
 * export means "no published preset yet"; the manager can still run and publish.
 */
export function publishedBundleSync(): LoadedBundle | null {
  try {
    const value = JSON.parse(readFileSync(join(BUNDLE_DIR, 'package.json'), 'utf8')) as BundleManifest;
    return value.piManager?.format === 1 && value.piManager.managerHome === MANAGER_HOME ? value.piManager : null;
  } catch { return null; }
}

export async function publishedBundle(): Promise<LoadedBundle | null> {
  try {
    const value = await readJson<BundleManifest>(await safePath(join(BUNDLE_DIR, 'package.json')));
    if (value.piManager?.format !== 1 || value.piManager.managerHome !== MANAGER_HOME) throw new Error('Invalid pi-manager export');
    return value.piManager;
  } catch (error) { if (errorCode(error) === 'ENOENT') return null; throw error; }
}

/** A snapshot carries resources this preset declares: package entries (copied or
 * referenced) and files inside the preset. User-level resources that Pi
 * auto-discovers from the home directory are deliberately excluded: Pi loads
 * them itself in every session, so exporting them would only add a live path
 * outside the snapshot that can silently go stale.
 */
export function exportableResources<T extends Pick<Resource, 'type' | 'enabled' | 'origin'>>(resources: T[]): (T & { type: PiResourceType })[] {
  return resources.filter((resource): resource is T & { type: PiResourceType } =>
    resource.enabled && resource.type !== 'context' && resource.origin !== 'global');
}

/** Publish a detached, immutable package snapshot for the next ordinary Pi start.
 * The live Pi keeps its old files even if a staging profile is edited/deleted.
 * External local packages are intentionally reference-only, not snapshotted.
 */
export async function publishBundle(profile: string | null): Promise<LoadedBundle> {
  await ensureManagerHome();
  return profile ? withProfileLock(profile, () => buildBundle(profile)) : buildBundle(null);
}

async function buildBundle(profile: string | null): Promise<LoadedBundle> {
  const id = `${Date.now()}-${randomUUID()}`;
  const root = await safePath(join(BUNDLE_DIR, '.snapshots', id));
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const loaded: LoadedBundle = { format: 1, id, profile, managerHome: MANAGER_HOME, contexts: [] };
    const paths: BundleManifest['pi'] = { extensions: [], skills: [], prompts: [], themes: [] };
    if (profile) {
      const source = await assertProfile(profile);
      const current = await inventory(profile);
      const settings = await getSettings(profile);
      const state = packageState(settings);
      const packages = state ? generationPath(source, state.active) : source;
      for (const kind of ['npm', 'git'] as const) await copyOwnedTree(join(packages, kind), join(root, kind));
      await copyOwnedTree(join(source, 'resources'), join(root, 'resources'));
      // Validation never installs or fetches. Refuse an incomplete/missing
      // declaration rather than publishing a misleading empty resource set.
      await writeJson(join(root, 'settings.json'), { packages: absoluteEntries(settings, source).packages });
      await runPackageWorker(root, [], { validate: true, allowMissing: false });
      const rebase = (path: string) => {
        for (const [from, to] of [[join(packages, 'npm'), join(root, 'npm')], [join(packages, 'git'), join(root, 'git')], [join(source, 'resources'), join(root, 'resources')]]) {
          if (isInside(from, path)) return join(to, relative(from, path));
        }
        return path;
      };
      for (const resource of exportableResources(current.resources)) {
        paths[resource.type].push(rebase(resource.path));
      }
      for (const context of (await getMetadata(profile)).contexts.filter(item => item.enabled)) {
        const path = rebase(join(source, context.path));
        if (!isInside(join(root, 'resources', 'context'), path)
          || !isInside(await realpath(join(root, 'resources', 'context')), await realpath(path))) throw new Error('Context export escaped its owned directory');
        loaded.contexts.push({ name: context.name, content: await readFile(path, 'utf8') });
      }
    }
    // The manager itself is installed as its own Pi package, so the snapshot
    // carries resources only. `piManager` below is the binding the manager reads
    // at startup (profile, manager home, published context).
    for (const type of RESOURCE_TYPES) paths[type] = [...new Set(paths[type])];
    const manifest: BundleManifest = { name: 'pi-manager-local-bundle', version: VERSION, private: true, type: 'module', pi: paths, piManager: loaded };
    // Atomic commit point. Nothing that can fail/deletes files follows it.
    await writeJson(join(BUNDLE_DIR, 'package.json'), manifest);
    return loaded;
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
