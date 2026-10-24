import { cp, lstat, mkdir, readdir, realpath, readlink, symlink, rm, open } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { safePath, writeJson, readJson, isInside } from './storage.js';
import { sourceOf, withSource, PACKAGE_STATE_KEY } from './package-state.js';
import { errorCode } from './errors.js';
import type { PiSettings, ProfileSettings, PackageMetadata, PackageBindings, WorkerOptions, WorkerSnapshot, PackageWorkerResult, GenerationCandidate, GenerationManifest } from './types.js';

const worker = fileURLToPath(new URL('./sdk-worker.js', import.meta.url));
export const generationId = () => `${Date.now()}-${randomUUID()}`;
export function generationPath(root: string, id: string) {
  if (!/^\d+-[a-f0-9-]{36}$/.test(id)) throw new Error(`Invalid package generation: ${id}`);
  return join(root, '.packages', id);
}

export async function verifyOwnedTree(root: string) {
  let stat;
  try { stat = await lstat(root); } catch (error) { if (errorCode(error) === 'ENOENT') return; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Not an owned package directory: ${root}`);
  const canonical = await realpath(root);
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        if (!isInside(canonical, await realpath(file))) throw new Error(`External package symlink cannot be snapshotted: ${file}`);
      } else if (entry.isDirectory()) await walk(file);
      else if (entry.name === '.git') throw new Error(`Linked Git worktrees are not owned package snapshots: ${file}`);
      else if (!entry.isFile()) throw new Error(`Unsupported package file: ${file}`);
    }
  }
  await walk(root);
}

// Copy real bytes, never hardlink active files. Dependency symlinks are allowed
// only within the copied tree and are recreated to point into the new tree.
export async function copyOwnedTree(source: string, destination: string) {
  let info;
  try { info = await lstat(source); } catch (error) { if (errorCode(error) === 'ENOENT') return; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Not an owned package directory: ${source}`);
  await verifyOwnedTree(source);
  const canonical = await realpath(source);
  await cp(source, destination, {
    recursive: true, verbatimSymlinks: true,
    filter: async path => {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        const actual = await realpath(path);
        if (!isInside(canonical, actual)) throw new Error(`External package symlink cannot be snapshotted: ${path}`);
      }
      return true;
    },
  });
  async function relocate(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const current = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        const original = join(source, relative(destination, current));
        const target = resolve(dirname(original), await readlink(original));
        const next = join(destination, relative(source, target));
        await rm(current);
        await symlink(relative(dirname(current), next), current);
      } else if (entry.isDirectory()) await relocate(current);
    }
  }
  await relocate(destination);
}

export function runPackageWorker(root: string, args: string[], options: WorkerOptions & { validate: true }): Promise<WorkerSnapshot>;
export function runPackageWorker(root: string, args?: string[], options?: WorkerOptions): Promise<PackageWorkerResult>;
export async function runPackageWorker(root: string, args: string[] = [], options: WorkerOptions = {}): Promise<WorkerSnapshot | PackageWorkerResult> {
  let output = '', truncated = false, failure: Error | undefined, result: unknown;
  const code = await new Promise<number>(resolveRun => {
    const custom = options.piCommand;
    const child = spawn(custom || process.execPath, custom ? args : [worker, ...args], {
      cwd: root, shell: false,
      ...(options.validate ? { timeout: 30000 } : {}),
      env: { ...process.env, ...options.env, PI_CODING_AGENT_DIR: root,
        PI_CODING_AGENT_SESSION_DIR: join(root, 'sessions'),
        ...(options.validate ? { PI_OFFLINE: '0', PI_MANAGER_VALIDATE_PACKAGES: '1', PI_MANAGER_ALLOW_MISSING: options.allowMissing ? '1' : '0' } : {}) },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('message', message => { result = message; });
    for (const stream of [child.stdout, child.stderr]) stream!.on('data', data => {
      const text = data.toString(); output += text;
      if (output.length > 8 * 1024 * 1024) { output = output.slice(-8 * 1024 * 1024); truncated = true; }
      options.onOutput?.(text);
    });
    child.on('error', error => { failure = error; });
    child.on('close', exit => resolveRun(exit ?? 1));
  });
  if (options.validate && code === 0) {
    try { result = JSON.parse(output); } catch { failure = new Error('Invalid validation response'); }
  }
  options.onLog?.({ code, output, truncated, error: failure?.message });
  if (failure) throw failure;
  if (code !== 0) throw new Error(`Package worker exited ${code}`);
  if (!result) throw new Error('Package worker returned no result');
  return result as WorkerSnapshot | PackageWorkerResult;
}

export function absoluteEntries(settings: PiSettings, base: string): ProfileSettings {
  const next = structuredClone(settings);
  delete next[PACKAGE_STATE_KEY];
  return { ...next, packages: (next.packages || []).map(entry => {
    const source = sourceOf(entry);
    return withSource(entry, source.startsWith('.') ? resolve(base, source) : source);
  }) };
}

export async function prepareGeneration(root: string, settings: PiSettings, metadata: PackageMetadata, previousDirectory?: string): Promise<GenerationCandidate> {
  const id = generationId();
  const path = await safePath(generationPath(root, id));
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    for (const kind of ['npm', 'git']) await copyOwnedTree(join(previousDirectory || root, kind), join(path, kind));
    const candidate = absoluteEntries(settings, root);
    // Candidate workers need only package-manager configuration, not user
    // context, credentials, resource paths or the active-generation pointer.
    for (const key of Object.keys(candidate)) if (!['packages', 'npmCommand', 'httpProxy'].includes(key)) delete candidate[key];
    await writeJson(join(path, 'settings.json'), candidate);
    await writeJson(join(path, 'generation.json'), {
      format: 1, id, createdAt: new Date().toISOString(), status: 'preparing',
      packages: candidate.packages, disabledPackages: metadata.disabledPackages || {},
    });
    return { id, path, settings: candidate };
  } catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
}

export async function generationDigest(path: string) {
  const hash = createHash('sha256');
  async function visit(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (errorCode(error) === 'ENOENT') { hash.update('missing:' + relative(path, directory)); return; } throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = join(directory, entry.name);
      const stat = await lstat(file);
      hash.update(JSON.stringify([relative(path, file), stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file', stat.mode & 0o777]));
      if (stat.isSymbolicLink()) hash.update(await readlink(file));
      else if (stat.isDirectory()) await visit(file);
      else {
        const handle = await open(file, 'r');
        try { for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); }
        finally { await handle.close(); }
      }
    }
  }
  for (const kind of ['npm', 'git']) await visit(join(path, kind));
  return hash.digest('hex');
}

export async function recordGeneration(candidate: GenerationCandidate, settings: PiSettings, metadata: PackageMetadata, bindings: PackageBindings, command: string) {
  await writeJson(join(candidate.path, 'settings.json'), settings);
  await writeJson(join(candidate.path, 'generation.json'), {
    format: 1, id: candidate.id, createdAt: new Date().toISOString(), status: 'ready', command,
    packages: settings.packages || [], bindings, disabledPackages: metadata.disabledPackages || {},
    digest: await generationDigest(candidate.path),
  });
}

export async function validateGeneration(root: string, id: string, options: WorkerOptions = {}): Promise<GenerationManifest> {
  const path = await safePath(generationPath(root, id));
  await safePath(join(path, 'settings.json'));
  const manifest = await readJson<GenerationManifest>(await safePath(join(path, 'generation.json')));
  if (manifest.format !== 1 || manifest.id !== id || manifest.status !== 'ready') throw new Error('Package generation is not ready');
  const savedSettings = await readJson<PiSettings>(join(path, 'settings.json'));
  if (JSON.stringify(savedSettings.packages || []) !== JSON.stringify(manifest.packages || [])) throw new Error('Package generation settings changed since validation');
  for (const kind of ['npm', 'git']) await verifyOwnedTree(join(path, kind));
  if (manifest.digest !== await generationDigest(path)) throw new Error('Package generation content changed since it was saved; restore refused');
  await runPackageWorker(path, [], { ...options, piCommand: undefined, validate: true, allowMissing: false });
  for (const binding of Object.values(manifest.bindings || {})) {
    if (!isInside(path, binding) || !isInside(await realpath(path), await realpath(binding))) throw new Error('Package generation points outside its owned directory');
  }
  return manifest;
}
