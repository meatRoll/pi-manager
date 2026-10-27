#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { publishBundle, publishedBundle, BUNDLE_DIR } from './bundle.js';
import { run } from './core.js';
import { sourcePiAgentDir } from './migration.js';
import { ensureManagerHome } from './storage.js';
import { errorMessage } from './errors.js';

/** Pi can only fast-forward `git:` sources, so the manager installs itself as one.
 * `PI_MANAGER_SELF_SOURCE` overrides it (a local path works offline); `none`
 * skips the self install for single-package setups and tests.
 */
export const DEFAULT_SELF_SOURCE = 'git:github.com/meatRoll/pi-manager';
const selfSource = () => process.env.PI_MANAGER_SELF_SOURCE ?? DEFAULT_SELF_SOURCE;
const looksLikeManager = (source: unknown) => typeof source === 'string' && /(?:^|[:\/])pi-manager(?:\.git)?$/.test(source);

/** A manager package declaration already in the Pi agent settings. */
export async function hasManagerPackage(agentDir = sourcePiAgentDir()): Promise<boolean> {
  try {
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')) as { packages?: unknown[] };
    return (settings.packages || []).some(entry => looksLikeManager(typeof entry === 'string' ? entry : (entry as { source?: string } | null)?.source));
  } catch { return false; }
}

/** Declarations that point at a previous publication directory, e.g. after
 * PI_MANAGER_PUBLISH_DIR moved. Pi only loads the newest registered path.
 */
export async function staleBundleDeclarations(agentDir = sourcePiAgentDir()): Promise<string[]> {
  try {
    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')) as { packages?: unknown[] };
    const stale: string[] = [];
    for (const entry of settings.packages || []) {
      const source = typeof entry === 'string' ? entry : (entry as { source?: string } | null)?.source;
      if (typeof source !== 'string' || !/(?:^|\/)pi-package$/.test(source)) continue;
      if (resolve(agentDir, source) !== BUNDLE_DIR) stale.push(source);
    }
    return stale;
  } catch { return []; }
}

export async function installPiExtension(acknowledged = false): Promise<void> {
  if (!acknowledged) throw new Error('Pass --yes to register pi-manager in the current Pi agent settings. No other resources, credentials or sessions are copied.');
  await ensureManagerHome();
  const pi = process.env.PI_MANAGER_PI || 'pi';
  const registered: string[] = [];
  const source = selfSource();
  // Register the manager itself first: the published snapshot only carries
  // resources, so a missing manager package would leave nothing to type.
  if (source !== 'none' && !await hasManagerPackage()) {
    const code = await run(pi, ['install', source]);
    if (code !== 0) throw new Error(`pi install ${source} exited ${code}`);
    registered.push(source);
  }
  // Refresh the published resources without dropping the chosen preset.
  await publishBundle((await publishedBundle())?.profile || null);
  const code = await run(pi, ['install', BUNDLE_DIR]);
  if (code !== 0) throw new Error(`pi install exited ${code}`);
  registered.push(BUNDLE_DIR);
  const stale = await staleBundleDeclarations();
  console.log([
    `Registered Pi packages: ${registered.join(', ')}`,
    ...(stale.length ? [`Remove the superseded declaration${stale.length > 1 ? 's' : ''}: pi remove ${stale.join(' ')}`] : []),
    registered.some(item => item === BUNDLE_DIR) ? `Published resources stay in ${BUNDLE_DIR}; update the manager with "pi update".` : '',
    'Restart Pi, then type /manager. No separate pi-manager process is needed.',
  ].filter(Boolean).join('\n'));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installPiExtension(process.argv.includes('--yes')).catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
}
