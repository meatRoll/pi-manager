import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PiSdk } from './types.js';

const PACKAGE = '@earendil-works/pi-coding-agent';
const require = createRequire(import.meta.url);

// Public SDK only. No imports of Pi internals, no runtime patching. Resolve the
// installed CLI's companion SDK or an explicitly supplied SDK package directory.
export function findPiSdk() {
  if (process.env.PI_MANAGER_SDK_PATH) return resolve(process.env.PI_MANAGER_SDK_PATH);
  try { return require.resolve(PACKAGE); } catch { /* not a local dependency */ }
  const command = process.env.PI_MANAGER_PI || 'pi';
  const candidates = command.includes('/') ? [resolve(command)]
    : (process.env.PATH || '').split(delimiter).map(dir => join(dir, command));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const executable = realpathSync(candidate);
    const managed = join(dirname(dirname(executable)), 'install');
    const current = join(managed, 'current-version');
    if (existsSync(current)) {
      const version = readFileSync(current, 'utf8').trim();
      if (!/^[A-Za-z0-9._+-]+$/.test(version)) throw new Error('Invalid managed Pi version');
      const pkg = join(managed, 'releases', version, 'node_modules', PACKAGE);
      if (existsSync(join(pkg, 'package.json'))) return pkg;
    }
    for (let cursor = dirname(executable); dirname(cursor) !== cursor; cursor = dirname(cursor)) {
      const manifest = join(cursor, 'package.json');
      try { if (JSON.parse(readFileSync(manifest, 'utf8')).name === PACKAGE) return cursor; }
      catch { /* continue walking */ }
    }
  }
  throw new Error('Pi SDK not found. Set PI_MANAGER_SDK_PATH to an installed @earendil-works/pi-coding-agent directory.');
}

export async function loadPiSdk(): Promise<PiSdk> {
  let path = findPiSdk();
  if (existsSync(join(path, 'package.json'))) {
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    path = resolve(path, manifest.main || 'dist/index.js');
  }
  return import(pathToFileURL(path).href) as Promise<PiSdk>;
}
