import { mkdir, readFile, writeFile, rename, rm, lstat, readdir, realpath, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpathSync, existsSync } from 'node:fs';
import { logicalSettings, physicalSettings, packageState } from './package-state.js';

function canonicalLocation(path) {
  const absolute = resolve(path);
  let ancestor = absolute;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  return resolve(realpathSync(ancestor), relative(ancestor, absolute));
}
export const MANAGER_HOME = canonicalLocation(process.env.PI_MANAGER_HOME || join(homedir(), '.pi-manager'));
export const PROFILES_DIR = join(MANAGER_HOME, 'profiles');
export const RESOURCE_TYPES = ['extensions', 'skills', 'prompts', 'themes'];

export function validName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(`Invalid name: ${name}. Use 1–64 letters, numbers, dots, underscores or hyphens.`);
  }
  return name;
}
export function profilePath(name) { return join(PROFILES_DIR, validName(name)); }
export function isInside(root, path) {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\');
}

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

// Refuse symlink write targets, including ancestors. This is an integrity check,
// not an OS security boundary against hostile concurrent filesystem mutations.
export async function safePath(path) {
  const absolute = resolve(path);
  if (!isInside(MANAGER_HOME, absolute)) throw new Error(`Write outside manager home refused: ${path}`);
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`Symlink write target refused: ${cursor}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(cursor) === cursor) break;
  }
  return absolute;
}
export async function writeText(path, text) {
  await safePath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
export async function writeJson(path, value) { await writeText(path, `${JSON.stringify(value, null, 2)}\n`); }
export async function ensureManagerHome() {
  const normalPi = resolve(homedir(), '.pi');
  if (isInside(normalPi, MANAGER_HOME) || isInside(MANAGER_HOME, normalPi)) {
    throw new Error('PI_MANAGER_HOME must not overlap ~/.pi.');
  }
  if (process.env.PI_CODING_AGENT_DIR) {
    const agent = resolve(process.env.PI_CODING_AGENT_DIR);
    if (!isInside(PROFILES_DIR, agent) && (isInside(agent, MANAGER_HOME) || isInside(MANAGER_HOME, agent))) {
      throw new Error('PI_MANAGER_HOME must not overlap the current Pi agent directory.');
    }
  }
  await safePath(PROFILES_DIR);
  await mkdir(PROFILES_DIR, { recursive: true, mode: 0o700 });
}
export async function assertProfile(name) {
  await ensureManagerHome();
  const path = await safePath(profilePath(name));
  const meta = await readJson(join(path, 'manager.json'));
  if (meta.format !== 1 || meta.name !== name) throw new Error(`Not a managed profile: ${name}`);
  // Prevent tampered profile subtrees from redirecting Pi package writes.
  for (const child of ['settings.json', 'manager.json', 'npm', 'git', 'sessions', 'resources', '.operations', '.packages', '.lock']) {
    await safePath(join(path, child));
  }
  return path;
}
export async function getSettings(name) { return logicalSettings(await readJson(join(await assertProfile(name), 'settings.json'))); }
export async function saveSettings(name, settings) { await writeJson(join(await assertProfile(name), 'settings.json'), physicalSettings(settings)); }
export async function getMetadata(name) {
  const root = await assertProfile(name);
  const metadata = await readJson(join(root, 'manager.json'));
  const state = packageState(await readJson(join(root, 'settings.json')));
  if (state) metadata.disabledPackages = structuredClone(state.disabledPackages || {});
  return metadata;
}
export async function saveMetadata(name, metadata) { await writeJson(join(await assertProfile(name), 'manager.json'), metadata); }
export async function getState() { return readJson(join(MANAGER_HOME, 'state.json'), { defaultProfile: null }); }
export async function setDefaultProfile(name) {
  if (name !== null) await assertProfile(name);
  await writeJson(join(MANAGER_HOME, 'state.json'), { ...await getState(), defaultProfile: name });
}
export async function listProfiles() {
  await ensureManagerHome();
  const state = await getState();
  const entries = await readdir(PROFILES_DIR, { withFileTypes: true });
  const profiles = [];
  for (const entry of entries.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const path = await assertProfile(entry.name);
      profiles.push({ name: entry.name, path, isDefault: state.defaultProfile === entry.name });
    } catch { /* Unmanaged directories are never adopted automatically. */ }
  }
  return profiles;
}

// All manager operations and manager-launched Pi runs share this lease. Another
// invocation refuses to mutate the profile while it is in use. No stale lock is
// automatically deleted: PID reuse and orphan children make that unsafe.
export async function withProfileLock(name, operation) {
  const root = await assertProfile(name);
  const path = join(root, '.lock');
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Profile ${name} is busy. If a previous manager crashed, verify no Pi/package process uses it before removing ${path}.`);
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await operation(root);
  } finally { await handle.close(); await rm(path, { force: true }); }
}

export async function assertContainedFile(root, path) {
  const canonicalRoot = await realpath(root);
  const canonical = await realpath(path);
  if (!isInside(canonicalRoot, canonical)) throw new Error(`Path escapes resource root: ${path}`);
  return canonical;
}
