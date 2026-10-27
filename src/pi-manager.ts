import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { listProfiles, createProfile, copyProfile, deleteProfile, profilePath, getState, setDefaultProfile, resolveSourcePath } from './core.js';
import { inventory, importResource, previewResource, writeResource, removeResource, createContext, toggleResource, originLabel } from './resources.js';
import { packageOperation, inspectPackage, togglePackage, packageVersions, rollbackPackages } from './packages.js';
import { migratePiPackages, sourcePiAgentDir } from './migration.js';
import { publishBundle, publishedBundle, BUNDLE_DIR } from './bundle.js';
import type { LoadedBundle } from './bundle.js';
import { choose, view, working } from './pi-ui.js';
import { dashboard, newDashboardState } from './dashboard.js';
import type { DashboardEntry, DashboardModel, DashboardTab } from './dashboard.js';
import { createPublicationInspector } from './publication-status.js';
import type { PublicationStatus } from './publication-status.js';
import { errorCode, errorMessage } from './errors.js';
import type { Resource, ResourceType, Inventory, ProfileSummary } from './types.js';

export function initialProfile(profiles: ProfileSummary[], defaultProfile?: string | null, loaded?: string | null, published?: string | null): string | undefined {
  return [defaultProfile, loaded, published, profiles[0]?.name].find(name => name && profiles.some(profile => profile.name === name)) || undefined;
}

export async function openManager(ctx: ExtensionCommandContext, loaded?: LoadedBundle): Promise<void> {
  let current: Inventory | undefined;
  const changed = () => { current = undefined; };
  const notify = (message = 'Saved to staging. Press P to publish for next Pi start; the current session is unchanged.') => ctx.ui.notify(message, 'info');
  const guard = async (action: () => Promise<unknown>) => {
    try { await action(); } catch (error) { ctx.ui.notify(errorMessage(error), 'error'); }
  };
  const mutate = async (action: () => Promise<unknown>) => { try { await action(); } finally { changed(); } };
  const publish = async (profile: string | null) => {
    if (!await ctx.ui.confirm('Use on next Pi start?', 'Exports a detached package snapshot. Restart Pi to load it; current extensions and context are unchanged. External local packages remain references.')) return;
    await mutate(async () => {
      const result = await working(ctx, 'Publishing package snapshot…', () => publishBundle(profile));
      notify(`Published ${result.profile || 'manager only'} for next Pi start. Restart Pi, do not expect hot unloading. Package: ${BUNDLE_DIR}`);
    });
  };
  const packageRun = async (profile: string, command: string, source?: string) => {
    if (!await ctx.ui.confirm(`${command} package?`, 'Third-party code and install scripts have your user permissions. Changes affect the staging profile only; publish afterward, then restart Pi.')) return;
    await mutate(async () => {
      const result = await working(ctx, `${command} package…`, () => packageOperation(profile, command, source, { cwd: ctx.cwd }));
      notify(`Saved generation ${result.generation}.${result.missingBaseline.length ? ' No complete restore baseline.' : ''} Publish for next Pi start. Log: ${result.logPath}`);
    });
  };
  const preview = async (profile: string, resource: Resource) => {
    const result = await previewResource(profile, resource.id);
    await view(ctx, resource.displayName, `${result.path}\n\n${result.text}${result.truncated ? '\n[truncated]' : ''}`);
  };
  const edit = async (profile: string, resource: Resource) => {
    if (!resource.owned) throw new Error('External/package resources are read-only. Import a copy to edit.');
    const result = await previewResource(profile, resource.id);
    if (result.truncated) throw new Error('File exceeds the 128 KiB editor limit');
    const text = await ctx.ui.editor(resource.displayName, result.text);
    if (text !== undefined) await mutate(async () => { await writeResource(profile, resource.id, text); notify(); });
  };
  const remove = async (profile: string, resource: Resource) => {
    if (!resource.owned) throw new Error('Only manager-owned resources can be deleted.');
    if (await ctx.ui.confirm('Delete owned copy?', resource.displayName)) await mutate(async () => { await removeResource(profile, resource.id); notify(); });
  };
  const toggle = async (profile: string, resource: Resource) => mutate(async () => { await toggleResource(profile, resource.id, !resource.enabled); });
  // RPC lacks custom components and keyboard actions; keep an explicit dialog fallback.
  const resourceActions = async (profile: string, resource: Resource) => {
    const action = await choose(ctx, `${resource.displayName} · ${resource.owned ? 'owned copy' : resource.origin === 'global' ? 'user-level read-only' : 'external / package read-only'}`, [
      { label: 'Preview', value: 'preview' },
      ...(resource.origin === 'global' ? [] : [{ label: resource.enabled ? 'Disable' : 'Enable', value: 'toggle' }]),
      ...(resource.owned ? [{ label: 'Edit in Pi', value: 'edit' }, { label: 'Delete owned copy', value: 'delete' }] : []),
    ]);
    if (action === 'preview') await preview(profile, resource);
    if (action === 'toggle') await toggle(profile, resource);
    if (action === 'edit') await edit(profile, resource);
    if (action === 'delete') await remove(profile, resource);
  };
  const packagePage = async (profile: string, source: string) => {
    while (true) {
      const state = await inventory(profile);
      const pkg = state.packages.find(item => item.source === source);
      if (!pkg) return;
      const action = await choose(ctx, `${pkg.displayName} · ${pkg.version || 'local'} — staging`, [
        { label: pkg.enabled ? 'Disable package' : 'Enable package', value: 'toggle' },
        { label: 'Package details', value: 'details' }, { label: 'Update package', value: 'update' },
        { label: 'Uninstall package', value: 'remove' },
        ...state.resources.filter(item => item.origin === 'package' && item.source === source).map(item => ({ label: `[${item.enabled ? 'x' : ' '}] ${item.type}: ${item.displayName}`, value: item.id })),
      ]);
      if (!action) return;
      await guard(async () => {
        if (action === 'toggle') await mutate(() => togglePackage(profile, source, !pkg.enabled));
        else if (action === 'details') await view(ctx, 'Package details', JSON.stringify(pkg, null, 2));
        else if (action === 'update' || action === 'remove') await packageRun(profile, action, source);
        else {
          const resource = state.resources.find(item => item.id === action);
          if (resource) await resourceActions(profile, resource);
        }
      });
    }
  };
  const add = async (profile: string, tab: DashboardTab) => {
    const kind = tab === 'all' || tab === 'more' ? await choose<ResourceType | 'packages'>(ctx, 'Add to staging',
      (['extensions', 'skills', 'context', 'packages', 'prompts', 'themes'] as const).map(value => ({ label: value, value }))) : tab;
    if (!kind) return;
    if (kind === 'packages') {
      const source = await ctx.ui.input('Add package', 'npm:name@version, git:host/owner/repo, or a local path');
      if (!source) return;
      const target = resolveSourcePath(source, ctx.cwd);
      await view(ctx, 'Package inspection', JSON.stringify(await working(ctx, 'Inspecting package…', () => inspectPackage(target)), null, 2));
      await packageRun(profile, 'add', target);
      return;
    }
    if (kind === 'context') {
      const action = await choose(ctx, 'Add context', [{ label: '+ Create context', value: 'create' }, { label: 'Import Markdown copy', value: 'import' }]);
      if (!action) return;
      if (action === 'create') {
        const name = await ctx.ui.input('New context', 'Name without .md');
        if (!name) return;
        const text = await ctx.ui.editor(`Context: ${name}`, `# ${name}\n\n`);
        if (text !== undefined) await mutate(async () => { await createContext(profile, name, text); notify(); });
        return;
      }
    }
    const path = await ctx.ui.input('Import local resource copy', 'Path relative to the current project, or absolute');
    if (path) await mutate(async () => {
      await importResource(profile, kind, resolveSourcePath(path.startsWith('~') ? path : resolve(ctx.cwd, path), ctx.cwd)); notify();
    });
  };
  const versionsPage = async (profile: string) => {
    const versions = await packageVersions(profile);
    const action = await choose(ctx, `Package generations · active: ${versions.active || 'legacy'} · previous: ${versions.previous || 'none'}`, [
      { label: 'View generation status', value: 'status' },
      ...(versions.previous ? [{ label: 'Restore previous package generation', value: 'restore' }] : []),
    ]);
    if (action === 'status') await view(ctx, 'Package generations', JSON.stringify(versions, null, 2));
    if (action === 'restore' && await ctx.ui.confirm('Restore previous staging packages?', 'Offline restore of packages and package filters only. Does not restore contexts, sessions or credentials. Publish afterward and restart Pi.')) {
      await mutate(async () => { await working(ctx, 'Validating previous generation…', () => rollbackPackages(profile)); notify(); });
    }
  };
  const logsPage = async (profile: string) => {
    let files: string[] = [];
    try { files = (await readdir(join(profilePath(profile), '.operations'))).filter(name => name.endsWith('.log')).sort().reverse(); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    const file = await choose(ctx, 'Package logs — review before sharing', files.map(value => ({ label: value, value })));
    if (file) await view(ctx, file, await readFile(join(profilePath(profile), '.operations', file), 'utf8'));
  };
  const migrate = async (profile: string) => {
    const source = sourcePiAgentDir();
    if (!await ctx.ui.confirm('Import current Pi packages?', `Read-only source: ${source}\nCopies installed npm/Git trees into this empty staging profile; skips the manager bundle. External local packages stay references. No downloads or extension execution. Do not update source packages concurrently. Original declarations remain active: verify the import, then explicitly remove duplicates before using the published preset.`)) return;
    await mutate(async () => {
      const result = await working(ctx, 'Importing current Pi packages…', () => migratePiPackages(profile, source));
      await view(ctx, 'Imported Pi packages — staging only', [
        `Source (unchanged): ${result.sourceAgentDir}`, `Generation: ${result.generation}`,
        `Imported (${result.imported.length}):\n${result.imported.join('\n')}`,
        `Skipped manager bundle:\n${result.skipped.join('\n') || '(none)'}`,
        `External local references:\n${result.externalLocal.join('\n') || '(none)'}`,
        'Verify the import before publishing. Original Pi declarations are unchanged; keeping them alongside the published copies can load extensions twice. Remove old declarations only after separate confirmation; keep original files for rollback.',
      ].join('\n\n'));
      notify(`Imported ${result.imported.length} packages into ${profile}. Source settings unchanged; review duplicate declarations before cutover.`);
    });
  };
  const about = () => view(ctx, 'About pi-manager', `This manager runs inside Pi. No nested Pi or second terminal UI.\n\nRegister ${BUNDLE_DIR} once with “pi install <path>” (or npm run install:pi in the checkout).\n\nSpace saves staging switches; Enter previews; E edits owned copies; A adds; P publishes; S switches staging presets. Publishing exports a detached snapshot. Restart Pi to load extensions, skills, prompts, themes and context. External local packages remain references. No hot unloading, runtime registry changes or Pi source patches.`);
  const pickProfile = async (): Promise<string | undefined> => {
    while (true) {
      const profiles = await listProfiles();
      const selected = await choose(ctx, 'pi-manager / Switch preset — staging only', [
        ...profiles.map(profile => ({ label: `${profile.isDefault ? '★ ' : ''}${profile.name}`, value: profile.name })),
        { label: '+ Create profile', value: ':create' },
        ...(!profiles.length ? [{ label: 'Use manager only on next Pi start', value: ':clear' }, { label: 'About / loading instructions', value: ':about' }] : []),
      ]);
      if (selected === ':clear' || selected === ':about') { await guard(() => selected === ':clear' ? publish(null) : about()); continue; }
      if (selected !== ':create') return selected;
      let created: string | undefined;
      await guard(async () => {
        const name = await ctx.ui.input('New profile', 'Letters, numbers, dots, underscores and hyphens');
        if (name) { await createProfile(name); created = name; }
      });
      if (created) return created;
    }
  };
  const moreEntries: DashboardEntry[] = [
    { id: 'prompts', label: 'Prompt templates' }, { id: 'themes', label: 'Themes' },
    { id: 'profiles', label: 'Manage / switch presets' },
    { id: 'migrate', label: 'Import packages from current Pi' }, { id: 'update', label: 'Update all packages' },
    { id: 'versions', label: 'Package generations / restore' }, { id: 'logs', label: 'Package operation logs' },
    { id: 'copy', label: 'Copy profile' }, { id: 'default', label: 'Set as default manager preset' },
    { id: 'delete-profile', label: 'Delete staging profile' },
    { id: 'manager-only', label: 'Use manager only on next Pi start' }, { id: 'about', label: 'About / loading instructions' },
  ];
  const profiles = await listProfiles();
  const publishedAtOpen = await publishedBundle();
  let profile = initialProfile(profiles, (await getState()).defaultProfile, loaded?.profile, publishedAtOpen?.profile) || await pickProfile();
  if (!profile) return;
  let state = newDashboardState();
  const inspectPublication = createPublicationInspector();
  let publicationId: string | undefined, status: PublicationStatus | 'checking' = 'checking';
  while (profile) {
    const published = await publishedBundle();
    const needsRead = !current || current.profile !== profile || publicationId !== published?.id;
    if (needsRead) { current = undefined; status = 'checking'; }
    const resourceRows = (type?: ResourceType): DashboardEntry[] => (current?.resources || []).filter(resource => !type || resource.type === type).map(resource => ({
      id: `resource:${resource.id}`, label: `[${resource.enabled ? 'x' : ' '}] ${resource.displayName}`,
      detail: `${resource.type} · ${originLabel(resource.origin)}${resource.owned ? ' · owned' : ' · read-only'}`,
      toggle: resource.origin !== 'global', editable: resource.owned, deletable: resource.owned,
    }));
    const makeModel = (): DashboardModel => ({
      profile: profile!, loading: `loaded: ${loaded?.profile || 'manager only'} · next start: ${published?.profile || 'manager only'}`,
      publication: status === 'checking' ? 'Checking publication in background… Current session unchanged'
        : status === 'unpublished' ? 'Unpublished changes · P publish for next start' : status === 'unknown' ? 'Publication status unknown · R refresh / P publish' : loaded?.id === published?.id ? 'Published · staging only; external local packages remain references' : 'Published · restart Pi to load; current session unchanged',
      pending: status === 'unknown' || status === 'checking' ? undefined : status === 'unpublished',
      busy: !current,
      rows: {
        all: resourceRows(), extensions: resourceRows('extensions'), skills: resourceRows('skills'),
        context: resourceRows('context'), prompts: resourceRows('prompts'), themes: resourceRows('themes'),
        packages: (current?.packages || []).map(pkg => ({ id: `package:${pkg.source}`, label: `[${pkg.enabled ? 'x' : ' '}] ${pkg.displayName}`, detail: pkg.version || 'local', toggle: true })),
        more: moreEntries,
      },
    });
    const load = async (update: (model: DashboardModel) => void, signal: AbortSignal) => {
      if (!current) {
        const result = await inventory(profile!, { signal });
        signal.throwIfAborted();
        current = result; publicationId = published?.id;
        // Resource actions are usable before the full byte comparison finishes.
        update(makeModel());
      }
      status = await inspectPublication(current, published, signal);
      signal.throwIfAborted(); update(makeModel());
    };
    if (ctx.mode !== 'tui' && needsRead) {
      // RPC requires complete options for select, but not a full integrity
      // check before that list is usable. Check in the background afterwards.
      try {
        current = await working(ctx, 'Reading staging metadata…', () => inventory(profile!), false);
        publicationId = published?.id;
      }
      catch (error) {
        ctx.ui.notify(errorMessage(error), 'error');
        const action = await choose(ctx, `Cannot read staging preset: ${profile}`, [{ label: 'Switch preset', value: 'switch' }, { label: 'Retry metadata', value: 'retry' }]);
        if (!action) return;
        if (action === 'switch') { const selected = await pickProfile(); if (!selected) return; profile = selected; state = newDashboardState(); }
        changed(); continue;
      }
    }
    const action = await dashboard(ctx, makeModel(), state, !current || status === 'checking' ? load : undefined);
    if (!action) return;
    await guard(async () => {
      if (action.kind === 'switch') {
        const selected = await pickProfile();
        if (selected && selected !== profile) { profile = selected; state = newDashboardState(); changed(); }
      } else if (action.kind === 'publish') await publish(profile!);
      else if (action.kind === 'add') await add(profile!, state.tab);
      else if (action.kind === 'refresh') changed();
      else if (action.id.startsWith('resource:')) {
        const resource = current!.resources.find(resource => `resource:${resource.id}` === action.id);
        if (!resource) return;
        if (action.kind === 'toggle') await toggle(profile!, resource);
        else if (action.kind === 'edit') await edit(profile!, resource);
        else if (action.kind === 'delete') await remove(profile!, resource);
        else if (ctx.mode === 'tui') await preview(profile!, resource);
        else await resourceActions(profile!, resource);
      } else if (action.id.startsWith('package:')) {
        const pkg = current!.packages.find(pkg => `package:${pkg.source}` === action.id);
        if (!pkg) return;
        if (action.kind === 'toggle') await mutate(() => togglePackage(profile!, pkg.source, !pkg.enabled));
        else await packagePage(profile!, pkg.source);
      } else if (action.id === 'prompts' || action.id === 'themes') state.tab = action.id;
      else if (action.id === 'profiles') { const selected = await pickProfile(); if (selected) { profile = selected; state = newDashboardState(); changed(); } }
      else if (action.id === 'versions') await versionsPage(profile!);
      else if (action.id === 'logs') await logsPage(profile!);
      else if (action.id === 'migrate') await migrate(profile!);
      else if (action.id === 'update') await packageRun(profile!, 'update');
      else if (action.id === 'default') { await setDefaultProfile(profile!); notify(`Default manager preset: ${profile}. This does not publish or switch the running Pi.`); }
      else if (action.id === 'copy') { const name = await ctx.ui.input('Copy profile', 'New name; no credentials, sessions or installs copied'); if (name) { await copyProfile(profile!, name); notify(`Copied staging preset: ${name}. Use S to switch.`); } }
      else if (action.id === 'delete-profile') {
        const name = await ctx.ui.input('Delete staging profile', `Type ${profile} to confirm. Deletes its sessions and credentials, not published snapshots.`);
        if (name === profile) {
          await deleteProfile(profile!); changed(); state = newDashboardState();
          profile = initialProfile(await listProfiles(), (await getState()).defaultProfile, loaded?.profile, (await publishedBundle())?.profile) || await pickProfile();
        }
      } else if (action.id === 'manager-only') await publish(null);
      else if (action.id === 'about') await about();
    });
  }
}
