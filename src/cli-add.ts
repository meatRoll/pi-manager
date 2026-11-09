import { getSettings, getState, assertProfile, listProfiles, profilePath } from './storage.js';
import { packageEntries, resolveSourcePath } from './core.js';
import { packageOperation, inspectPackage } from './packages.js';
import { publishForPi, publishedBundle } from './bundle.js';
import { isGitSource, planDeclarations, sourceIdentity } from './declarations.js';
import { errorMessage } from './errors.js';
import { plain } from './terminal.js';

/** Non-interactive counterpart to the `/manager` workflow: one command stages a
 * package and, with --publish, activates the snapshot for the next Pi start.
 * Agents are the main caller, so every failure still says what happened to the
 * staging profile and what to run next.
 */
export interface AddOptions {
  sources: string[];
  profile?: string;
  publish: boolean;
  dryRun: boolean;
  json: boolean;
  yes: boolean;
}

export interface StagedPackage {
  source: string;
  generation: string;
  previous: string | null;
  log: string;
  missingBaseline: string[];
}

export interface AddReport {
  ok: boolean;
  profile: string;
  staged: StagedPackage[];
  published: { snapshot: string; profile: string | null; declarations: number } | null;
  publishError?: string;
  requiresRestart: boolean;
}

export interface DryRunEntry {
  source: string;
  kind: 'npm' | 'git' | 'local';
  identity: string;
  action: 'add' | 'update';
  name?: string;
  version?: string;
  notice?: string;
}

export interface DryRunReport {
  ok: true;
  dryRun: true;
  profile: string;
  planned: DryRunEntry[];
  publish: { wouldPublish: true; currentSnapshot: string | null; currentProfile: string | null } | null;
}

const PROFILE_FLAG = '--profile';

export const ADD_USAGE = `pi-manager add <source>... [--profile <name>] [--publish] [--dry-run] [--json] --yes

Stages each source in a preset and, with --publish, activates the snapshot for
the next Pi start. The running session keeps its current resources.

  <source>   npm:name@version, git:host/owner/repo@ref, or a local path
  --profile  preset to stage into; default: saved default preset, else the only one
  --publish  publish and activate the snapshot (never implied by --yes)
  --dry-run  report what would happen; nothing is staged, published or written
  --json     one JSON object: {ok, profile, staged[], published, publishError?}
  --yes      acknowledge third-party code and install scripts (required unless --dry-run)

Project .pi settings are never written and Pi is never restarted.`;

export const PUBLISH_USAGE = `pi-manager publish [--profile <name>] [--dry-run] [--json]

Publishes the active preset and activates it for the next Pi start: the same
transaction as pressing P in /manager. --dry-run compares the staged preset with
the active publication and writes nothing.`;

export function parseAddOptions(args: string[]): AddOptions {
  const sources: string[] = [];
  const options: AddOptions = { sources, publish: false, dryRun: false, json: false, yes: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--yes') { options.yes = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--publish') { options.publish = true; continue; }
    if (arg === '--dry-run') { options.dryRun = true; continue; }
    const inline = arg.startsWith(`${PROFILE_FLAG}=`) ? arg.slice(PROFILE_FLAG.length + 1) : undefined;
    if (arg === PROFILE_FLAG || inline !== undefined) {
      const value = inline ?? args[++index];
      if (!value) throw new Error(`${PROFILE_FLAG} requires a preset name. See --help.`);
      options.profile = value;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown add option: ${arg}. See --help.`);
    sources.push(arg);
  }
  if (!sources.length) throw new Error('add needs at least one package source: npm:name@version, git:host/owner/repo@ref, or a local path. See --help.');
  return options;
}

/** The preset a command operates on: explicit flag, then the saved default, then
 * the only existing preset. Never invents a profile.
 */
export async function resolveActiveProfile(requested?: string): Promise<string> {
  if (requested) { await assertProfile(requested); return requested; }
  const state = await getState();
  if (state.defaultProfile) { await assertProfile(state.defaultProfile); return state.defaultProfile; }
  const profiles = await listProfiles();
  if (profiles.length === 1) return profiles[0].name;
  throw new Error(profiles.length
    ? `No default preset. Pass ${PROFILE_FLAG} <name>. Available: ${profiles.map(profile => profile.name).join(', ')}`
    : 'No staging preset exists yet. Create one in /manager, or run: pi-manager profile create mine');
}

function emitJson(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function reportLines(report: AddReport) {
  const lines = report.staged.map(item => [
    `Staged ${item.source} in preset ${report.profile}; generation ${item.generation}.`,
    ...(item.missingBaseline.length ? [`No restorable baseline: missing ${item.missingBaseline.join(', ')}.`] : []),
    `Log: ${item.log}`,
  ].join('\n'));
  if (report.published) {
    lines.push(`Published snapshot ${report.published.snapshot} for the next Pi start${report.published.declarations ? ` · ${report.published.declarations} package declaration${report.published.declarations === 1 ? '' : 's'} applied` : ''}.`);
    lines.push(`Restart Pi to load it. Undo with: pi-manager package rollback ${report.profile} --yes`);
  } else if (report.publishError) {
    lines.push(`Staged but not published: ${report.publishError}`);
    lines.push(`Staging is intact. Fix the error, then run: pi-manager publish ${PROFILE_FLAG} ${report.profile}`);
  } else {
    lines.push('Staged only. Publish from /manager or rerun with --publish; Pi is unchanged until then.');
  }
  return lines.join('\n');
}

function dryRunLines(report: DryRunReport) {
  const lines = ['Dry run — nothing was staged, published or written.', `Preset: ${report.profile}`];
  for (const item of report.planned) {
    const facts = [item.kind, item.version].filter(Boolean).join(' ');
    lines.push(`  ${item.action.padEnd(6)} ${item.source}  · ${facts}${item.name ? ` (${item.name})` : ''}${item.notice ? ` — ${item.notice}` : ''}`);
  }
  if (report.publish) {
    lines.push(`Would publish preset ${report.profile} after staging. Current publication: ${report.publish.currentSnapshot ?? '(none)'}${report.publish.currentProfile ? ` (${report.publish.currentProfile})` : ''}.`);
  } else {
    lines.push('Staging only; pass --publish to also activate the next Pi start.');
  }
  return lines.join('\n');
}

/** Read-only preview: resolve each source, compare it with the staged preset and
 * describe the publication without touching staging, the publication or Pi.
 */
async function reportDryRun(profile: string, options: AddOptions): Promise<void> {
  const staged = new Set(packageEntries(await getSettings(profile), profilePath(profile))
    .map(item => sourceIdentity(item.identity) ?? item.identity));
  const planned: DryRunEntry[] = [];
  for (const source of options.sources) {
    const target = resolveSourcePath(source);
    const identity = sourceIdentity(target) ?? target;
    const entry: DryRunEntry = {
      source, identity, action: staged.has(identity) ? 'update' : 'add',
      kind: target.startsWith('npm:') ? 'npm' : isGitSource(target) ? 'git' : 'local',
    };
    try {
      const inspection = await inspectPackage(source);
      const manifest = inspection.manifest as { name?: unknown; version?: unknown } | undefined;
      if (typeof manifest?.name === 'string') entry.name = manifest.name;
      if (typeof manifest?.version === 'string') entry.version = manifest.version;
      if (inspection.notice) entry.notice = inspection.notice;
    } catch (error) {
      entry.notice = `Metadata unavailable: ${errorMessage(error)}`;
    }
    planned.push(entry);
  }
  const published = options.publish ? await publishedBundle().catch(() => null) : null;
  const report: DryRunReport = {
    ok: true, dryRun: true, profile, planned,
    publish: options.publish
      ? { wouldPublish: true, currentSnapshot: published?.id ?? null, currentProfile: published?.profile ?? null }
      : null,
  };
  if (options.json) emitJson(report);
  else process.stdout.write(`${dryRunLines(report)}\n`);
}

/** Stage one or more sources, optionally publish, and report the resulting
 * generation and snapshot. `--yes` acknowledges third-party code only; it never
 * implies --publish, and --dry-run needs no acknowledgement at all.
 */
export async function runAdd(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(`${ADD_USAGE}\n`); return; }
  const json = args.includes('--json');
  let options: AddOptions;
  try { options = parseAddOptions(args); }
  catch (error) {
    if (json) { emitJson({ ok: false, stage: 'arguments', error: errorMessage(error) }); process.exitCode = 1; return; }
    throw error;
  }
  if (options.dryRun) return reportDryRun(await resolveActiveProfile(options.profile), options);
  if (!options.yes) throw new Error('Pass --yes to acknowledge third-party package code and install scripts. Staging alone still executes install scripts.');
  const profile = await resolveActiveProfile(options.profile);
  const staged: StagedPackage[] = [];
  for (const source of options.sources) {
    const result = await packageOperation(profile, 'add', source, options.json
      ? {}
      : { onOutput: text => process.stdout.write(plain(text)) });
    staged.push({ source, generation: result.generation, previous: result.previous, log: result.logPath, missingBaseline: result.missingBaseline });
  }
  const report: AddReport = { ok: true, profile, staged, published: null, requiresRestart: true };
  if (options.publish) {
    try {
      const bundle = await publishForPi(profile);
      report.published = { snapshot: bundle.id, profile: bundle.profile, declarations: bundle.declarations?.length ?? 0 };
    } catch (error) {
      report.ok = false;
      report.publishError = errorMessage(error);
    }
  }
  if (options.json) emitJson(report);
  else process.stdout.write(`${reportLines(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}

export interface PublishReport {
  ok: boolean;
  profile: string;
  snapshot: string;
  declarations: number;
  requiresRestart: boolean;
}

export interface PublishPreview {
  ok: true;
  dryRun: true;
  profile: string;
  currentSnapshot: string | null;
  declarations: { total: number; added: string[]; removed: string[]; skipped: { source: string; reason: string }[] };
}

/** Publish the active preset without touching packages. Same transaction the
 * `/manager` **P** key runs, so a failed `add --publish` stays recoverable.
 */
export async function runPublish(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(`${PUBLISH_USAGE}\n`); return; }
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  let profile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json' || arg === '--dry-run') continue;
    const inline = arg.startsWith(`${PROFILE_FLAG}=`) ? arg.slice(PROFILE_FLAG.length + 1) : undefined;
    if (arg === PROFILE_FLAG || inline !== undefined) {
      profile = inline ?? args[++index];
      if (!profile) throw new Error(`${PROFILE_FLAG} requires a preset name. See --help.`);
      continue;
    }
    throw new Error(`Unknown publish option: ${arg}. See --help.`);
  }
  const active = await resolveActiveProfile(profile);
  if (dryRun) {
    const planned = await planDeclarations(active);
    const published = await publishedBundle();
    const before = new Set((published?.declarations ?? []).map(item => item.identity));
    const after = new Set(planned.declarations.map(item => item.identity));
    const preview: PublishPreview = {
      ok: true, dryRun: true, profile: active, currentSnapshot: published?.id ?? null,
      declarations: {
        total: after.size,
        added: [...after].filter(identity => !before.has(identity)),
        removed: [...before].filter(identity => !after.has(identity)),
        skipped: planned.skipped,
      },
    };
    if (json) emitJson(preview);
    else process.stdout.write(`${[
      'Dry run — nothing published; the active snapshot and the running Pi are unchanged.',
      `Preset: ${active} · current publication: ${preview.currentSnapshot ?? '(none)'}`,
      `Declarations: ${preview.declarations.total} total · ${preview.declarations.added.length} added · ${preview.declarations.removed.length} removed`,
      ...preview.declarations.added.map(identity => `  + ${identity}`),
      ...preview.declarations.removed.map(identity => `  - ${identity}`),
      ...preview.declarations.skipped.map(item => `  skipped ${item.source}: ${item.reason}`),
    ].join('\n')}\n`);
    return;
  }
  const bundle = await publishForPi(active);
  const report: PublishReport = { ok: true, profile: active, snapshot: bundle.id, declarations: bundle.declarations?.length ?? 0, requiresRestart: true };
  if (json) emitJson(report);
  else process.stdout.write(`${[
    `Published preset ${active} as snapshot ${bundle.id} for the next Pi start.`,
    ...(report.declarations ? [`Declared ${report.declarations} package${report.declarations === 1 ? '' : 's'} at their published refs.`] : []),
    'Restart Pi to load it. Nothing changed in the running session.',
  ].join('\n')}\n`);
}
