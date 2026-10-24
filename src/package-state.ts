import type { PackageEntry, PackageState, PiSettings } from './types.js';

// One atomic profile/settings.json write selects the package generation and its
// resource filters together. Pi only sees ordinary local package sources.
export const PACKAGE_STATE_KEY = 'piManagerPackages';
export const sourceOf = (entry: PackageEntry): string => typeof entry === 'string' ? entry : entry.source;
export const withSource = (entry: PackageEntry, source: string): PackageEntry => typeof entry === 'string' ? source : { ...entry, source };

export function packageState(raw: PiSettings): PackageState | null {
  const state = raw[PACKAGE_STATE_KEY];
  if (!state) return null;
  if (state.format !== 1 || typeof state.active !== 'string' || typeof state.bindings !== 'object' || state.bindings === null || Array.isArray(state.bindings)
    || Object.values(state.bindings).some(path => typeof path !== 'string')) {
    throw new Error('Invalid manager package state; refusing to guess the active generation');
  }
  return state;
}
export function logicalSettings(raw: PiSettings): PiSettings {
  const settings = structuredClone(raw);
  const state = packageState(raw);
  if (state) {
    const sources = new Map(Object.entries(state.bindings).map(([source, path]) => [path, source]));
    settings.packages = (settings.packages || []).map(entry => withSource(entry, sources.get(sourceOf(entry)) || sourceOf(entry)));
  }
  return settings;
}
export function physicalSettings(settings: PiSettings, state = packageState(settings)): PiSettings {
  const raw = structuredClone(settings);
  if (state) {
    raw[PACKAGE_STATE_KEY] = structuredClone(state);
    raw.packages = (settings.packages || []).map(entry => withSource(entry, state.bindings[sourceOf(entry)] || sourceOf(entry)));
  }
  return raw;
}
export function isRemoteSource(source: string) {
  return /^(?:npm:|git:|https?:\/\/|ssh:|git\+|git@)/.test(source);
}
