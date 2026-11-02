// Published package declarations.
//
// A snapshot must not turn a Git package into an anonymous local file: Pi labels
// resources from the declaring package source, so flattening `git:host/owner/repo`
// into a copied path loses the repository identity (and with it the
// `owner/repo:path` label, package grouping and `pi update` reachability).
//
// Publishing therefore exports *declarations*: the profile's own package entries,
// with Git sources pinned to the exact commit of the active generation and npm
// sources pinned to the installed version. The bytes stay in the snapshot for
// durability and offline seeding, but Pi keeps loading them through its own
// package manager.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getSettings, packageEntries, profilePath } from './core.js';
import { generationPath } from './generations.js';
import { packageState, sourceOf, withSource } from './package-state.js';
import { gitRepositoryParts } from './package-label.js';
import { loadPiSdk } from './pi-sdk.js';
import type { PackageEntry, PiSdk, PublishedDeclaration } from './types.js';

const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

/** Read the checked-out commit without touching the network. */
export async function gitCommit(directory: string, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  return await new Promise<string | undefined>(resolve => {
    let output = '', failed = false;
    const child = spawn('git', ['-C', directory, 'rev-parse', 'HEAD'], {
      env: { ...GIT_ENV, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, signal,
    });
    child.stdout.on('data', chunk => {
      if (failed) return;
      output += chunk;
      if (output.length > 4096) { failed = true; child.kill(); }
    });
    child.on('error', () => { failed = true; });
    // Wait for close even on abort so no background process survives publication.
    child.on('close', code => {
      const commit = output.trim();
      resolve(!failed && code === 0 && /^[0-9a-f]{7,64}$/i.test(commit) ? commit : undefined);
    });
  });
}

/** Pi accepts `git:`, `https://`, `ssh://`, `git://` and scp-style sources.
 * All of them are Git packages and keep their identity when pinned.
 */
export function isGitSource(source: string): boolean {
  return source.startsWith('git:') || /^(?:(?:git\+)?(?:https?|ssh|git):\/\/|git@)/i.test(source);
}

/** Split a configured Git source into its repository and optional ref.
 * Only the ref is dropped; the spelling (protocol, host, subgroup, `git:` prefix)
 * stays byte-identical so the pinned declaration keeps the same package identity.
 */
export function splitGitSource(source: string): { repository: string; ref?: string } {
  const trimmed = source.trim();
  const prefixed = trimmed.startsWith('git:');
  const body = prefixed ? trimmed.slice(4) : trimmed;
  const scp = /^(git@[^:]+:)(.+)$/.exec(body);
  const head = scp ? scp[1]! : '';
  const rest = scp ? scp[2]! : body;
  const at = rest.lastIndexOf('@');
  if (at > rest.lastIndexOf('/')) {
    const path = rest.slice(0, at);
    const ref = rest.slice(at + 1);
    if (path && ref) return { repository: `${prefixed ? 'git:' : ''}${head}${path}`, ref };
  }
  return { repository: trimmed };
}

export function gitIdentity(source: string): string | undefined {
  const parts = gitRepositoryParts(splitGitSource(source).repository);
  return parts ? `git:${parts.host}/${parts.path}` : undefined;
}

export function npmIdentity(source: string): string | undefined {
  const name = /^npm:((?:@[^/@\s]+\/)?[^@\s]+)/.exec(source.trim())?.[1];
  return name ? `npm:${name}` : undefined;
}

/** Identity shared with Pi's own package matching: `git:host/path`, `npm:name`,
 * or the resolved local path. */
export function sourceIdentity(source: string): string | undefined {
  if (source.startsWith('npm:')) return npmIdentity(source);
  if (isGitSource(source)) return gitIdentity(source);
  return source.startsWith('/') ? `local:${source}` : undefined;
}

export interface PlannedDeclarations {
  declarations: PublishedDeclaration[];
  /** Configured packages that could not be resolved to a stable identity. */
  skipped: { source: string; reason: string }[];
}

async function packageVersion(directory: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof manifest.version === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(manifest.version)
      ? manifest.version
      : undefined;
  } catch { return undefined; }
}

/** Convert the profile's configured packages into publishable declarations.
 * `shouldSkip` lets the caller drop the manager's own package and its bundle.
 */
export async function planDeclarations(
  profile: string,
  options: { shouldSkip?: (entry: PackageEntry) => boolean } = {},
): Promise<PlannedDeclarations> {
  const root = profilePath(profile);
  const settings = await getSettings(profile);
  const state = packageState(settings);
  const base = state ? generationPath(root, state.active) : root;
  const declarations: PublishedDeclaration[] = [];
  const skipped: { source: string; reason: string }[] = [];
  const snapshotPath = (checkout: string | undefined) =>
    checkout?.startsWith(`${base}/`) ? checkout.slice(base.length + 1) : undefined;

  for (const item of packageEntries(settings, root)) {
    if (options.shouldSkip?.(item.entry)) continue;
    const source = item.source;
    const checkout = state?.bindings?.[source];

    if (isGitSource(source)) {
      const identity = gitIdentity(source);
      if (!identity) { skipped.push({ source, reason: 'unrecognized Git source' }); continue; }
      if (!checkout) { skipped.push({ source, reason: 'no bound checkout' }); continue; }
      const commit = await gitCommit(checkout);
      if (!commit) { skipped.push({ source, reason: 'checkout has no readable commit' }); continue; }
      declarations.push({
        kind: 'git', source, identity,
        pinned: `${splitGitSource(source).repository}@${commit}`,
        ref: commit, snapshot: snapshotPath(checkout), filters: item.entry,
      });
      continue;
    }

    if (source.startsWith('npm:')) {
      const identity = npmIdentity(source);
      if (!identity) { skipped.push({ source, reason: 'unrecognized npm source' }); continue; }
      const version = checkout ? await packageVersion(checkout) : undefined;
      if (!version) { skipped.push({ source, reason: 'installed package has no version' }); continue; }
      declarations.push({
        kind: 'npm', source, identity,
        pinned: `npm:${identity.slice('npm:'.length)}@${version}`,
        ref: version, snapshot: snapshotPath(checkout), filters: item.entry,
      });
      continue;
    }

    // Local package: a reference, exactly like Pi's own local source handling.
    const identity = sourceIdentity(source);
    if (!identity) { skipped.push({ source, reason: 'unresolvable local source' }); continue; }
    declarations.push({ kind: 'local', source, identity, pinned: source, filters: item.entry });
  }

  return { declarations, skipped };
}

/** Declaration entries in Pi's settings shape, filters preserved. */
export function declarationEntries(declarations: PublishedDeclaration[]): PackageEntry[] {
  return declarations.map(item => item.filters
    ? withSource(item.filters, item.pinned)
    : item.pinned);
}

export interface ActivationResult {
  applied: string[];
  removed: string[];
  unchanged: boolean;
}

/** Write declarations through Pi's public settings manager, replacing the ones a
 * previous publication installed and leaving every other declaration untouched.
 * Checkouts are installed first, so a successful activation is loadable offline.
 */
export async function activateDeclarations(
  next: PackageEntry[],
  previousIdentities: Iterable<string>,
  options: { agentDir: string; cwd?: string; sdk?: PiSdk; install?: boolean },
): Promise<ActivationResult> {
  const sdk = options.sdk ?? await loadPiSdk();
  const settingsManager = sdk.SettingsManager.create(options.cwd || options.agentDir, options.agentDir);
  const manager = new sdk.DefaultPackageManager({
    cwd: options.cwd || options.agentDir,
    agentDir: options.agentDir,
    settingsManager,
  });
  const before = settingsManager.getGlobalSettings().packages ?? [];
  const owned = new Set(previousIdentities);

  // Install pinned checkouts first; a publication must not be loadable only
  // when the network happens to be up. A failure leaves the previous
  // declarations in place, so a rejected publication never half-applies.
  try {
    if (options.install !== false) {
      for (const entry of next) {
        const source = sourceOf(entry);
        if (!isGitSource(source) && !source.startsWith('npm:')) continue;
        const installed = manager.getInstalledPath(source, 'user');
        const wanted = isGitSource(source) ? splitGitSource(source).ref : undefined;
        const current = installed && wanted && isGitSource(source) ? await gitCommit(installed) : undefined;
        if (current && wanted?.startsWith(current)) continue;
        await manager.install(source);
      }
    }
  } catch (error) {
    throw new Error(`Cannot install a declared package: ${(error as Error).message}`);
  }

  // Replace matching declarations in place so the settings order a user sees in
  // /extensions stays stable; append genuinely new declarations at the end.
  const replacements = new Map<string, PackageEntry>();
  for (const entry of next) {
    const identity = sourceIdentity(sourceOf(entry));
    if (identity) replacements.set(identity, entry);
  }
  const kept: PackageEntry[] = [];
  const placed = new Set<string>();
  for (const entry of before) {
    const identity = sourceIdentity(sourceOf(entry));
    if (!identity) { kept.push(entry); continue; }
    const replacement = replacements.get(identity);
    if (replacement) {
      kept.push(replacement);
      placed.add(identity);
      continue;
    }
    if (owned.has(identity)) continue; // published by us, no longer declared
    kept.push(entry);
  }
  for (const entry of next) {
    const identity = sourceIdentity(sourceOf(entry));
    if (identity && placed.has(identity)) continue;
    kept.push(entry);
  }

  const changed = JSON.stringify(kept) !== JSON.stringify(before);
  if (changed) settingsManager.setPackages(kept);
  const applied = next.map(entry => sourceOf(entry));
  const removed = before
    .map(entry => sourceOf(entry))
    .filter(source => !applied.includes(source) && owned.has(sourceIdentity(source) ?? ''));
  return { applied, removed, unchanged: !changed };
}

/** Apply the declarations recorded by a publication; a legacy (format 1)
 * publication carries none, so this is a no-op for it.
 */
export async function applyPublishedDeclarations(
  published: { declarations?: PublishedDeclaration[]; superseded?: string[] } | null,
  options: { agentDir: string; cwd?: string; sdk?: PiSdk; install?: boolean },
): Promise<ActivationResult | undefined> {
  if (!published?.declarations) return undefined;
  return activateDeclarations(
    declarationEntries(published.declarations),
    published.superseded ?? [],
    options,
  );
}
