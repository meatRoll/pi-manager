import type { StdioOptions } from 'node:child_process';

export type PiResourceType = 'extensions' | 'skills' | 'prompts' | 'themes';
export type ResourceType = PiResourceType | 'context';

export interface PackageSpec extends Partial<Record<PiResourceType, string[]>> {
  source: string;
  autoload?: boolean;
  [key: string]: unknown;
}
export type PackageEntry = string | PackageSpec;
export type PackageBindings = Record<string, string>;
export type DisabledPackages = Record<string, PackageEntry>;
export interface PackageMetadata { disabledPackages?: DisabledPackages }

export interface PackageCheckpoint {
  id: string;
  bindings: PackageBindings;
  packages: PackageEntry[];
  disabledPackages: DisabledPackages;
}
export interface PackageState {
  format: 1;
  active: string;
  bindings: PackageBindings;
  disabledPackages: DisabledPackages;
  previous?: PackageCheckpoint;
  missing?: string[];
}

/** Only manager-used fields are typed; unrelated Pi settings round-trip intact. */
export interface PiSettings extends Partial<Record<PiResourceType, string[]>> {
  packages?: PackageEntry[];
  npmCommand?: string | string[];
  httpProxy?: string;
  piManagerPackages?: PackageState;
  [key: string]: unknown;
}
export interface ProfileSettings extends PiSettings { packages: PackageEntry[] }
export interface ContextFile { name: string; path: string; enabled: boolean }
export interface ProfileMetadata extends PackageMetadata {
  format: 1;
  name: string;
  createdAt: string;
  copiedFrom?: string;
  disabledPackages: DisabledPackages;
  contexts: ContextFile[];
  [key: string]: unknown;
}
export interface ManagerState { defaultProfile: string | null }
export interface ProfileSummary { name: string; path: string; isDefault: boolean }
export interface ConfiguredPackage {
  index: number;
  source: string;
  identity: string;
  entry: PackageEntry;
  enabled: boolean;
}
export interface InstalledPackage {
  source: string;
  installedPath?: string;
  name?: string;
  version?: string;
  description?: string;
}
export interface InventoryPackage extends ConfiguredPackage, InstalledPackage {}
export interface ResolvedResource {
  path: string;
  enabled: boolean;
  metadata: { origin: string; source: string; packageRoot?: string };
}
export interface WorkerSnapshot {
  paths: Record<PiResourceType, ResolvedResource[]>;
  packages: InstalledPackage[];
  missing: string[];
}
export interface PackageWorkerResult { settings: PiSettings }
export interface Resource {
  id: string;
  type: ResourceType;
  path: string;
  name: string;
  enabled: boolean;
  origin: 'package' | 'standalone';
  source: string;
  packageRoot?: string;
  owned: boolean;
}
export interface Inventory {
  profile: string;
  root: string;
  packages: InventoryPackage[];
  resources: Resource[];
}
export interface ResourcePreview extends Resource { text: string; truncated: boolean }

export interface RunOptions { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: StdioOptions }
export interface PiRunOptions extends RunOptions { piCommand?: string }
export interface WorkerLog { code: number; output: string; truncated: boolean; error?: string }
export interface WorkerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  piCommand?: string;
  onOutput?: (text: string) => void;
  onLog?: (result: WorkerLog) => void;
  validate?: boolean;
  allowMissing?: boolean;
}
export interface GenerationCandidate { id: string; path: string; settings: ProfileSettings }
export interface GenerationManifest {
  format: 1;
  id: string;
  createdAt: string;
  status: 'ready';
  command: string;
  packages: PackageEntry[];
  bindings: PackageBindings;
  disabledPackages: DisabledPackages;
  digest: string;
}
export interface PackageOperationOptions extends WorkerOptions {
  beforeCommit?: (candidate: GenerationCandidate) => void | Promise<void>;
}
export interface RollbackOptions extends WorkerOptions { beforeCommit?: () => void | Promise<void> }
export interface PackageInspection {
  kind: 'local' | 'git' | 'npm';
  source: string;
  manifest?: unknown;
  notice?: string;
}

/** Structural boundary for the dynamically located, public Pi SDK API. */
export interface PiSettingsManager {
  getGlobalSettings(): PiSettings;
  setPackages(packages: PackageEntry[]): void;
}
export interface PiPackageManager {
  setProgressCallback(callback: (event: { message?: string }) => void): void;
  installAndPersist(source: string): Promise<void>;
  removeAndPersist(source: string): Promise<boolean>;
  update(source?: string): Promise<void>;
  listConfiguredPackages(): InstalledPackage[];
  resolve(onMissing: () => Promise<'skip'>): Promise<WorkerSnapshot['paths']>;
}
export interface PiSdk {
  SettingsManager: { inMemory(settings: PiSettings, options: { projectTrusted: boolean }): PiSettingsManager };
  DefaultPackageManager: new (options: { cwd: string; agentDir: string; settingsManager: PiSettingsManager }) => PiPackageManager;
}
