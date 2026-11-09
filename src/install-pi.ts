#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { publishBundle, publishedBundle, BUNDLE_DIR, assertPublishLocation } from './bundle.js';
import { run } from './core.js';
import { sourcePiAgentDir } from './migration.js';
import { applyPublishedDeclarations } from './declarations.js';
import { canonicalLocation, ensureManagerHome, rememberPublishDir } from './storage.js';
import { networkEnvironment } from './proxy.js';
import { errorMessage } from './errors.js';

/** Pi can only fast-forward `git:` sources, so the manager installs itself as one.
 * `PI_MANAGER_SELF_SOURCE` overrides it (a local path works offline); `none`
 * skips the self install for single-package setups and tests.
 */
export const DEFAULT_SELF_SOURCE = 'git:github.com/meatRoll/pi-manager';
const selfSource = () => process.env.PI_MANAGER_SELF_SOURCE ?? DEFAULT_SELF_SOURCE;
export const looksLikeManager = (source: unknown) => typeof source === 'string' && /(?:^|[:\/])pi-manager(?:\.git)?$/.test(source);

/** A manager package declaration already in the Pi agent settings. */
export async function hasManagerPackage(agentDir = sourcePiAgentDir()): Promise<boolean> {
  try {
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')) as { packages?: unknown[] };
    return (settings.packages || []).some(entry => looksLikeManager(typeof entry === 'string' ? entry : (entry as { source?: string } | null)?.source));
  } catch { return false; }
}

/** Local declarations of a published bundle: a manifest carrying a piManager
 * binding, or a legacy "…/pi-package" directory that no longer exists.
 */
export async function bundleDeclarations(agentDir = sourcePiAgentDir()): Promise<string[]> {
  try {
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')) as { packages?: unknown[] };
    const found: string[] = [];
    for (const entry of settings.packages || []) {
      const source = typeof entry === 'string' ? entry : (entry as { source?: string } | null)?.source;
      if (typeof source !== 'string' || /^(npm|git):/.test(source)) continue;
      const path = resolve(agentDir, source);
      try {
        const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as { piManager?: unknown };
        if (manifest.piManager) found.push(source);
      } catch { if (/(?:^|\/)pi-package$/.test(source)) found.push(source); }
    }
    return found;
  } catch { return []; }
}
/** Declarations pointing at a previous publication directory: Pi loads every one
 * of them, so a moved publish directory must be re-registered and the old one
 * removed or resources appear twice.
 */
export async function staleBundleDeclarations(agentDir = sourcePiAgentDir()): Promise<string[]> {
  const publish = canonicalLocation(BUNDLE_DIR);
  return (await bundleDeclarations(agentDir)).filter(source => canonicalLocation(resolve(agentDir, source)) !== publish);
}

export async function installPiExtension(acknowledged = false): Promise<void> {
  if (!acknowledged) throw new Error('Pass --yes to register pi-manager in the current Pi agent settings. No other resources, credentials or sessions are copied.');
  await ensureManagerHome();
  const pi = process.env.PI_MANAGER_PI || 'pi';
  const env = await networkEnvironment();
  const registered: string[] = [];
  const source = selfSource();
  // Register the manager itself first: the published snapshot only carries
  // resources, so a missing manager package would leave nothing to type.
  if (source !== 'none' && !await hasManagerPackage()) {
    const code = await run(pi, ['install', source], { env });
    if (code !== 0) throw new Error(`pi install ${source} exited ${code}`);
    registered.push(source);
  }
  // Refresh the published resources without dropping the chosen preset. A build
  // that cannot rewrite the active export still registers both packages.
  assertPublishLocation();
  let republishWarning: string | null = null;
  let published: Awaited<ReturnType<typeof publishBundle>> | null = null;
  try {
    published = await publishBundle((await publishedBundle())?.profile || null, {
      activate: true, install: true, agentDir: sourcePiAgentDir(), cwd: process.cwd(),
    });
  } catch (error) { republishWarning = `Left the existing publication untouched: ${errorMessage(error)}`; }
  const remembered = await rememberPublishDir();
  const code = await run(pi, ['install', BUNDLE_DIR], { env });
  if (code !== 0) throw new Error(`pi install exited ${code}`);
  registered.push(BUNDLE_DIR);
  // Repair the declarations without touching checkouts: publishing already
  // reconciled them, and this pass only exists for an older or interrupted
  // publication. Format 1 publications carry copied files and have nothing.
  const activation = published
    ? await applyPublishedDeclarations(published, { agentDir: sourcePiAgentDir(), cwd: process.cwd(), install: false })
    : undefined;
  const stale = await staleBundleDeclarations();
  console.log([
    `Registered Pi packages: ${registered.join(', ')}`,
    ...(remembered ? [`Saved ${remembered} as the publish directory for future runs.`] : []),
    ...(republishWarning ? [republishWarning] : []),
    ...(activation?.applied.length ? [`Declared ${activation.applied.length} package${activation.applied.length === 1 ? '' : 's'} at their published refs.`] : []),
    ...(stale.length ? [`Remove the superseded declaration${stale.length > 1 ? 's' : ''}: pi remove ${stale.map(item => resolve(sourcePiAgentDir(), item)).join(' ')}`] : []),
    registered.some(item => item === BUNDLE_DIR) ? `Published resources stay in ${BUNDLE_DIR}; update the manager with "pi update".` : '',
    'Restart Pi, then type /manager. No separate pi-manager process is needed.',
  ].filter(Boolean).join('\n'));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installPiExtension(process.argv.includes('--yes')).catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
}
