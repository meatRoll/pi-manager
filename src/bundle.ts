import { accessSync, constants, readFileSync, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inventory } from './resources.js';
import { assertProfile, ensureManagerHome, withProfileLock, MANAGER_HOME, PUBLISH_DIR, PUBLISH_DIR_SOURCE, RESOURCE_TYPES, safePath, writeJson, readJson, isInside } from './storage.js';
import { copyOwnedTree, generationPath, absoluteEntries, runPackageWorker } from './generations.js';
import { packageState } from './package-state.js';
import { getSettings, getMetadata, resolveSourcePath } from './core.js';
import { planDeclarations, activateDeclarations, declarationEntries } from './declarations.js';
import { homedir } from 'node:os';
import { errorCode } from './errors.js';
import { VERSION } from './version.js';
import type { PackageEntry, PiResourceType, PiSdk, PublishedDeclaration, Resource, ResourceType } from './types.js';

/** Pi agent directory a publication activates into. Resolved locally instead of
 * importing migration.ts, which already depends on this module.
 */
function defaultAgentDir(): string {
  return resolve(resolveSourcePath(process.env.PI_MANAGER_SOURCE_AGENT_DIR
    || process.env.PI_CODING_AGENT_DIR
    || join(homedir(), '.pi', 'agent')));
}

export const BUNDLE_DIR = PUBLISH_DIR;
export interface LoadedBundle {
  /** 1: every resource is copied into the snapshot. 2: package resources are
   * declared and installed by the publication. Both are readable because a newer
   * build may publish one; this build must not fail to start on it. */
  format: 1 | 2;
  id: string;
  profile: string | null;
  managerHome: string;
  contexts: { name: string; content: string }[];
  /** Format 2: package declarations this publication installs into Pi. */
  declarations?: PublishedDeclaration[];
  /** Format 2: identities installed by the previous publication. */
  superseded?: string[];
  /** Newer fields are read through untouched, never invented here. */
  [key: string]: unknown;
}
interface BundleManifest {
  name: string;
  version: string;
  private: true;
  type: 'module';
  pi: Record<Exclude<ResourceType, 'context'>, string[]>;
  piManager: LoadedBundle;
}

/** Accept every format this build can read or write, but only if the export
 * actually describes this manager home and names a snapshot in a usable form. */
export const WRITABLE_FORMAT = 2;
function isLoadedBundle(value: unknown, managerHome: string): value is LoadedBundle {
  const candidate = value as LoadedBundle | undefined;
  return (candidate?.format === 1 || candidate?.format === 2)
    && candidate.managerHome === managerHome
    && typeof candidate.id === 'string' && candidate.id.length > 0;
}

/** Startup binding for the manager package itself. Any unreadable or malformed
 * export means "no published preset yet"; the manager can still run and publish.
 */
export function publishedBundleSync(): LoadedBundle | null {
  try {
    const value = JSON.parse(readFileSync(join(BUNDLE_DIR, 'package.json'), 'utf8')) as BundleManifest;
    return isLoadedBundle(value.piManager, MANAGER_HOME) ? value.piManager : null;
  } catch { return null; }
}

export async function publishedBundle(): Promise<LoadedBundle | null> {
  try {
    const value = await readJson<BundleManifest>(await safePath(join(BUNDLE_DIR, 'package.json'))) as BundleManifest;
    if (!isLoadedBundle(value.piManager, MANAGER_HOME)) throw new Error('Invalid pi-manager export');
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

/** Resources the bundle itself must carry: everything the preset owns, plus
 * package resources whose provenance could not be pinned. Package resources that
 * are declared stay packages, so Pi keeps their repository identity (labels,
 * grouping, `pi update`).
 */
export function carriedResources<T extends Pick<Resource, 'type' | 'enabled' | 'origin' | 'source'>>(
  resources: T[],
  pinnedSources: Iterable<string>,
): (T & { type: PiResourceType })[] {
  const pinned = new Set(pinnedSources);
  return exportableResources(resources).filter(resource => resource.origin !== 'package' || !pinned.has(resource.source));
}

/** The manager installs itself and its bundle explicitly; re-declaring either
 * from a publication would register `/manager` twice.
 */
export function isManagerOrBundle(entry: PackageEntry, baseDir: string): boolean {
  const source = typeof entry === 'string' ? entry : entry.source;
  if (source.startsWith('npm:') || source.startsWith('git:')) return false;
  const resolved = isAbsolute(source) ? source : resolve(baseDir, source);
  if (resolve(resolved) === resolve(BUNDLE_DIR)) return true;
  try {
    return JSON.parse(readFileSync(join(resolved, 'package.json'), 'utf8')).name === 'pi-manager';
  } catch { return false; }
}

export const DEFAULT_SNAPSHOT_RETENTION = 2;
export interface SnapshotPruneResult {
  directory: string;
  active: string | null;
  keep: number;
  retained: string[];
  toRemove: string[];
  removed: string[];
  dryRun: boolean;
  reason?: string;
}

function descendingSnapshotIds(ids: string[]) {
  return [...ids].sort((a, b) => a < b ? 1 : a > b ? -1 : 0);
}

/** Remove old detached snapshots while preserving the current package binding.
 * `keep` includes the active snapshot. Without an active package manifest the
 * operation is a safe no-op because there is no reliable root to protect.
 */
export async function prunePublishedSnapshots(
  keep = DEFAULT_SNAPSHOT_RETENTION,
  apply = false,
): Promise<SnapshotPruneResult> {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('Snapshot retention must be a positive integer.');
  await ensureManagerHome();
  assertPublishLocation();
  const base = { directory: BUNDLE_DIR, active: null as string | null, keep, retained: [] as string[], toRemove: [] as string[], removed: [] as string[], dryRun: !apply };
  const published = await publishedBundle();
  if (!published) return { ...base, reason: 'No active published bundle; nothing was removed.' };
  if (!published.id || published.id.includes('/') || published.id.includes('\\\\')) {
    throw new Error(`Invalid active snapshot id: ${published.id || '(empty)'}`);
  }
  const active = published.id;
  const root = await safePath(join(BUNDLE_DIR, '.snapshots'));
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(`Active published snapshot is missing: ${active}; refusing to prune.`);
    throw error;
  }
  const snapshots = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  if (!snapshots.includes(active)) throw new Error(`Active published snapshot is missing: ${active}; refusing to prune.`);
  const retained = [active, ...descendingSnapshotIds(snapshots.filter(id => id !== active)).slice(0, keep - 1)];
  const toRemove = snapshots.filter(id => !retained.includes(id));
  const removed: string[] = [];
  if (apply) {
    for (const id of toRemove) {
      await rm(await safePath(join(root, id)), { recursive: true, force: true });
      removed.push(id);
    }
  }
  return { directory: BUNDLE_DIR, active, keep, retained, toRemove, removed, dryRun: !apply };
}

/** Never recreate an explicitly configured publish directory on the boot disk when
 * its volume is missing: fail loudly instead of publishing where Pi is not
 * registered to read. A missing mount point such as /Volumes/disk leaves an
 * unwritable ancestor, which is what this checks. A default directory inside the
 * manager home needs no check.
 */
export function publishLocationAvailable(directory = PUBLISH_DIR) {
  let ancestor = directory;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  try { accessSync(ancestor, constants.W_OK); return true; }
  catch { return false; }
}
export function assertPublishLocation() {
  if (PUBLISH_DIR_SOURCE === 'default' || publishLocationAvailable()) return;
  throw new Error(`Publish directory unavailable: ${PUBLISH_DIR}. Mount its volume, or point "pi-manager config publish-dir" elsewhere.`);
}

/** Publish a detached, immutable package snapshot for the next ordinary Pi start.
 * The live Pi keeps its old files even if a staging profile is edited/deleted.
 * External local packages are intentionally reference-only, not snapshotted.
 */
export interface PublishOptions {
  /** Write the declarations into Pi's settings as part of the transaction.
   * Off by default so tests and pure exports never touch a real Pi install.
   */
  activate?: boolean;
  /** Reconcile pinned checkouts during activation (needs the network on a
   * changed commit). Installers keep this on; `/manager` repairs separately.
   */
  install?: boolean;
  agentDir?: string;
  cwd?: string;
  /** Test seam: resolve Pi's SDK without importing it. */
  sdk?: PiSdk;
}

/** The published format number, including formats this build cannot read, so a
 * publication never silently replaces a newer one.
 */
async function publishedFormat(): Promise<number | null> {
  try {
    const value = await readJson<BundleManifest>(await safePath(join(BUNDLE_DIR, 'package.json'))) as BundleManifest;
    const format = (value.piManager as { format?: unknown } | undefined)?.format;
    return typeof format === 'number' ? format : null;
  } catch { return null; }
}

export async function publishBundle(profile: string | null, options: PublishOptions = {}): Promise<LoadedBundle> {
  await ensureManagerHome();
  assertPublishLocation();
  // A newer build may publish a format this one cannot even read. Overwriting it
  // would silently drop whatever that format carries (for example package
  // declarations), so refuse instead. An unreadable manifest is not protected:
  // publishing over it repairs the export.
  const existing = await publishedFormat();
  if (existing !== null && existing > WRITABLE_FORMAT) {
    throw new Error(`The active publication uses format ${existing}, which this build cannot rewrite. Update the manager instead of republishing, or publish with the build that produced it.`);
  }
  return profile ? withProfileLock(profile, () => buildBundle(profile, options)) : buildBundle(null, options);
}

async function buildBundle(profile: string | null, options: PublishOptions = {}): Promise<LoadedBundle> {
  const id = `${Date.now()}-${randomUUID()}`;
  const root = await safePath(join(BUNDLE_DIR, '.snapshots', id));
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    // The previous publication decides which declarations this one supersedes;
    // read it before the new manifest replaces it.
    const previous = await publishedBundle().catch(() => null);
    const loaded: LoadedBundle = { format: 2, id, profile, managerHome: MANAGER_HOME, contexts: [] };
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
      // Only resources this preset owns travel inside the bundle. Package
      // resources stay packages: Pi declares them from the entry below, so a
      // Git extension keeps its `owner/repo:path` identity instead of decaying
      // into a copied file path.
      const planned = await planDeclarations(profile, {
        shouldSkip: entry => isManagerOrBundle(entry, source),
      });
      // A package that cannot be pinned (checkout without Git metadata, unknown
      // source) falls back to the copied form: resources must never disappear
      // because provenance could not be preserved.
      for (const resource of carriedResources(current.resources, planned.declarations.map(item => item.source))) {
        paths[resource.type].push(rebase(resource.path));
      }
      loaded.declarations = planned.declarations;
      loaded.superseded = previous?.declarations?.map(item => item.identity) ?? [];
      for (const context of (await getMetadata(profile)).contexts.filter(item => item.enabled)) {
        const path = rebase(join(source, context.path));
        if (!isInside(join(root, 'resources', 'context'), path)
          || !isInside(await realpath(join(root, 'resources', 'context')), await realpath(path))) throw new Error('Context export escaped its owned directory');
        loaded.contexts.push({ name: context.name, content: await readFile(path, 'utf8') });
      }
    } else {
      // Manager-only publication: drop every declaration the last preset added.
      loaded.declarations = [];
      loaded.superseded = previous?.declarations?.map(item => item.identity) ?? [];
    }
    // The manager itself is installed as its own Pi package, so the snapshot
    // carries resources only. `piManager` below is the binding the manager reads
    // at startup (profile, manager home, published context).
    for (const type of RESOURCE_TYPES) paths[type] = [...new Set(paths[type])];
    const manifest: BundleManifest = { name: 'pi-manager-local-bundle', version: VERSION, private: true, type: 'module', pi: paths, piManager: loaded };
    // Declarations land in Pi's settings before the manifest commits: a
    // publication that cannot be loaded is worse than a rejected one. On
    // failure the previous publication stays active and the snapshot is removed.
    if (options.activate) {
      await activateDeclarations(
        declarationEntries(loaded.declarations ?? []),
        loaded.superseded ?? [],
        {
          agentDir: options.agentDir ?? defaultAgentDir(),
          cwd: options.cwd ?? process.cwd(),
          install: options.install !== false,
          sdk: options.sdk,
        },
      );
    }
    // Atomic commit point. Nothing that can fail/deletes files follows it.
    await writeJson(join(BUNDLE_DIR, 'package.json'), manifest);
    return loaded;
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
