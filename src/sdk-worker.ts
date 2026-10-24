// Public package manager only; no extension factory is imported or applied.
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { loadPiSdk } from './pi-sdk.js';
import { isRemoteSource } from './package-state.js';
import { errorCode, errorMessage } from './errors.js';
import type { PiSettings } from './types.js';

try {
  const { SettingsManager, DefaultPackageManager } = await loadPiSdk();
  const root = process.env.PI_CODING_AGENT_DIR;
  if (!root) throw new Error('PI_CODING_AGENT_DIR is required');
  const settings: PiSettings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'));
  const settingsManager = SettingsManager.inMemory(settings, { projectTrusted: false });
  const manager = new DefaultPackageManager({ cwd: root, agentDir: root, settingsManager });
  const [operation, source] = process.argv.slice(2);
  if (operation) {
    manager.setProgressCallback(event => { if (event.message) console.error(event.message); });
    if (operation !== 'update' && !source) throw new Error('Package source is required');
    if (operation === 'install') await manager.installAndPersist(source!);
    else if (operation === 'remove') {
      if (!await manager.removeAndPersist(source!)) throw new Error('No matching configured package');
    } else if (operation === 'update') await manager.update(source === '--extensions' ? undefined : source);
    else throw new Error('Unknown package operation');
    if (!process.send) throw new Error('Package worker requires IPC');
    process.send({ settings: settingsManager.getGlobalSettings() }, () => process.exit(0));
    await new Promise(() => {});
  }
  const validate = process.env.PI_MANAGER_VALIDATE_PACKAGES === '1';
  const missing: string[] = [];
  if (validate) {
    for (const pkg of manager.listConfiguredPackages()) {
      try {
        if (!pkg.installedPath) throw Object.assign(new Error(`Missing package: ${pkg.source}`), { code: 'ENOENT' });
        const actual = await realpath(pkg.installedPath);
        const rel = relative(await realpath(root), actual);
        if (isRemoteSource(pkg.source) && (isAbsolute(rel) || rel === '..' || rel.startsWith('../'))) {
          throw Object.assign(new Error(`Package resolved outside candidate generation: ${pkg.source}`), { code: 'ENOENT' });
        }
        await stat(actual);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT' || process.env.PI_MANAGER_ALLOW_MISSING !== '1') throw error;
        missing.push(pkg.source);
      }
    }
    if (missing.length) settingsManager.setPackages((settings.packages || []).filter(entry => !missing.includes(typeof entry === 'string' ? entry : entry.source)));
  }
  const paths = await manager.resolve(async () => {
    if (validate) throw new Error('Missing package files during generation validation');
    return 'skip';
  });
  const packages = await Promise.all(manager.listConfiguredPackages().map(async pkg => {
    let manifest: { name?: string; version?: string; description?: string } | undefined;
    try { if (pkg.installedPath) manifest = JSON.parse(await readFile(join(pkg.installedPath, 'package.json'), 'utf8')); } catch { /* local module or missing manifest */ }
    return { ...pkg, name: manifest?.name, version: manifest?.version, description: manifest?.description };
  }));
  process.stdout.write(JSON.stringify({ paths, packages, missing }));
} catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
