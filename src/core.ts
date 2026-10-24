import { mkdir, rm, cp, readdir, lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { PACKAGE_STATE_KEY } from './package-state.js';
import { errorCode } from './errors.js';
import type { PiSettings, PackageMetadata, RunOptions, PiRunOptions } from './types.js';
import {
  MANAGER_HOME, PROFILES_DIR, profilePath, validName, ensureManagerHome,
  writeJson, safePath, assertProfile, assertContainedFile, getSettings, saveSettings,
  getMetadata, saveMetadata, getState, setDefaultProfile, listProfiles, withProfileLock,
} from './storage.js';
export { MANAGER_HOME, PROFILES_DIR, profilePath, ensureManagerHome, assertProfile, getSettings,
  saveSettings, getMetadata, saveMetadata, getState, setDefaultProfile, listProfiles, withProfileLock };

export async function createProfile(name: string) {
  await ensureManagerHome();
  const root = await safePath(profilePath(name));
  await mkdir(root, { mode: 0o700 }); // no recursive: existing profiles must not be overwritten
  try {
    await writeJson(join(root, 'settings.json'), {
      packages: [], extensions: [], skills: [], prompts: [], themes: [],
      enableInstallTelemetry: false, enableAnalytics: false,
      defaultProjectTrust: 'never',
    });
    await writeJson(join(root, 'manager.json'), {
      format: 1, name, createdAt: new Date().toISOString(), disabledPackages: {}, contexts: [],
    });
    if (!(await getState()).defaultProfile) await setDefaultProfile(name);
    return root;
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

export async function deleteProfile(name: string) {
  await withProfileLock(name, async root => {
    // Keep the lock until all other content is gone.
    for (const entry of await readdir(root)) if (entry !== '.lock') await rm(await safePath(join(root, entry)), { recursive: true, force: true });
  });
  await rm(profilePath(name), { recursive: true });
  if ((await getState()).defaultProfile === name) await setDefaultProfile((await listProfiles())[0]?.name ?? null);
}

export async function copyProfile(from: string, to: string) {
  validName(to);
  return withProfileLock(from, async source => {
    const destination = await createProfile(to);
    try {
      const settings = structuredClone(await getSettings(from));
      delete settings[PACKAGE_STATE_KEY]; // copied profiles never share writable generation state
      const rebase = (value: string) => {
        if (value === source || value.startsWith(`${source}/`)) return destination + value.slice(source.length);
        if (value.startsWith('.') || value.startsWith('~') || value.startsWith('/')) return resolveSourcePath(value, source);
        return value;
      };
      settings.packages = (settings.packages || []).map(entry => typeof entry === 'string'
        ? rebase(entry) : { ...entry, source: rebase(entry.source) });
      // Imported resources are profile-relative and copied below. Other explicit
      // resource paths are rebased to retain their original meaning.
      for (const type of ['extensions', 'skills', 'prompts', 'themes'] as const) {
        settings[type] = (settings[type] || []).map(value => {
          const prefix = /^[+!-]/.test(value) ? value[0] : '';
          const path = prefix ? value.slice(1) : value;
          return path.startsWith('resources/') ? value : prefix + rebase(path);
        });
      }
      await saveSettings(to, settings);
      const metadata = await getMetadata(from);
      delete metadata.packageGeneration;
      metadata.disabledPackages = Object.fromEntries(Object.entries(metadata.disabledPackages || {}).map(([key, entry]) => [
        rebase(key), typeof entry === 'string' ? rebase(entry) : { ...entry, source: rebase(entry.source) },
      ]));
      await saveMetadata(to, { ...metadata, name: to, copiedFrom: from, createdAt: new Date().toISOString() });
      try {
        await cp(join(source, 'resources'), join(destination, 'resources'), {
          recursive: true, verbatimSymlinks: true,
          filter: async path => { if ((await lstat(path)).isSymbolicLink()) throw new Error('Cannot copy symlinked resources'); return true; },
        });
      } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
      return destination;
    } catch (error) { await deleteProfile(to); throw error; }
  });
}

export function resolveSourcePath(source: string, cwd = process.cwd()) {
  if (typeof source !== 'string' || !source.trim() || source.startsWith('-') || /[\0\r\n]/.test(source)) throw new Error('Invalid package source');
  const value = source.trim().replace(/^file:/, '');
  if (value === '~' || value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  if (value.startsWith('.') || value.startsWith('/')) return resolve(cwd, value);
  return value;
}
export function packageEntries(settings: PiSettings, baseDir = process.cwd(), metadata: PackageMetadata = {}) {
  return (settings.packages || []).map((entry, index) => {
    const source = typeof entry === 'string' ? entry : entry.source;
    return { index, source, identity: resolveSourcePath(source, baseDir), entry,
      enabled: !Object.hasOwn(metadata.disabledPackages || {}, source) };
  });
}
export function profileEnv(name: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra, PI_CODING_AGENT_DIR: profilePath(name), PI_CODING_AGENT_SESSION_DIR: join(profilePath(name), 'sessions') };
  return env;
}

export function run(command: string, args: string[], options: RunOptions = {}): Promise<number> {
  return new Promise<number>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(), env: options.env || process.env,
      stdio: options.stdio || 'inherit', shell: false,
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolveRun(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
}

export async function runPi(name: string, args: string[] = [], options: PiRunOptions = {}) {
  return withProfileLock(name, async root => {
    const metadata = await getMetadata(name);
    const contextArgs: string[] = [];
    for (const context of metadata.contexts || []) {
      if (context.enabled) {
        const path = await safePath(join(root, context.path));
        await assertContainedFile(join(root, 'resources', 'context'), path);
        contextArgs.push('--append-system-prompt', path);
      }
    }
    // Trust remains Pi's concern; manager opts out unless explicitly requested.
    const launchArgs = args.includes('--approve') || args.includes('-a') || args.includes('--no-approve')
      ? args : ['--no-approve', ...args];
    return run(options.piCommand || process.env.PI_MANAGER_PI || 'pi', [...contextArgs, ...launchArgs], {
      cwd: options.cwd || process.cwd(), env: profileEnv(name, options.env), stdio: options.stdio || 'inherit',
    });
  });
}

export async function readProfileInstructions(name: string) {
  const root = await assertProfile(name);
  const meta = await getMetadata(name);
  return Promise.all((meta.contexts || []).map(async context => ({
    ...context, content: await readFile(join(root, context.path), 'utf8'),
  })));
}
