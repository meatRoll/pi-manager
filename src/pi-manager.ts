import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { listProfiles, createProfile, copyProfile, deleteProfile, profilePath, getState, resolveSourcePath } from './core.js';
import { inventory, importResource, previewResource, writeResource, removeResource, createContext, toggleResource } from './resources.js';
import { packageOperation, inspectPackage, togglePackage, packageVersions, rollbackPackages } from './packages.js';
import { publishBundle, publishedBundle, BUNDLE_DIR } from './bundle.js';
import type { LoadedBundle } from './bundle.js';
import { choose, view, working } from './pi-ui.js';
import type { Choice } from './pi-ui.js';
import { errorCode, errorMessage } from './errors.js';
import type { Resource, ResourceType, InventoryPackage } from './types.js';

export async function openManager(ctx: ExtensionCommandContext, loaded?: LoadedBundle): Promise<void> {
  const notify = (message = 'Saved. Use “Use on next Pi start” to publish your changes.') => ctx.ui.notify(message, 'info');
  const guard = async (action: () => Promise<unknown>) => {
    try { await action(); } catch (error) { ctx.ui.notify(errorMessage(error), 'error'); }
  };
  const inputPath = async () => {
    const path = await ctx.ui.input('Import local resource', 'Path relative to the current project, or absolute');
    return path ? resolveSourcePath(path.startsWith('~') ? path : resolve(ctx.cwd, path), ctx.cwd) : undefined;
  };
  const publish = async (profile: string | null) => {
    if (!await ctx.ui.confirm('Use on next Pi start?', 'Exports a detached package snapshot. Restart Pi to load it; current extensions and context are unchanged. External local packages remain references.')) return;
    const result = await working(ctx, 'Publishing package snapshot…', () => publishBundle(profile));
    notify(`Published ${result.profile || 'manager only'} for next Pi start. Restart Pi, do not expect hot unloading. Package: ${BUNDLE_DIR}`);
  };
  const packageRun = async (profile: string, command: string, source?: string) => {
    if (!await ctx.ui.confirm(`${command} package?`, 'Third-party code and install scripts have your user permissions. Changes affect the staging profile only; publish afterward, then restart Pi.')) return;
    const result = await working(ctx, `${command} package…`, () => packageOperation(profile, command, source, { cwd: ctx.cwd }));
    notify(`Saved generation ${result.generation}.${result.missingBaseline.length ? ' No complete restore baseline.' : ''} Publish for next Pi start. Log: ${result.logPath}`);
  };
  const edit = async (profile: string, resource: Resource) => {
    const preview = await previewResource(profile, resource.id);
    if (preview.truncated) throw new Error('File exceeds the 128 KiB editor limit');
    const text = await ctx.ui.editor(resource.name, preview.text);
    if (text !== undefined) { await writeResource(profile, resource.id, text); notify(); }
  };
  const resourcePage = async (profile: string, resource: Resource) => {
    const action = await choose(ctx, `${resource.name} · ${resource.owned ? 'owned copy' : 'external / package read-only'}`, [
      { label: 'Preview', value: 'preview' },
      { label: resource.enabled ? 'Disable' : 'Enable', value: 'toggle' },
      ...(resource.owned ? [{ label: 'Edit in Pi', value: 'edit' }, { label: 'Delete owned copy', value: 'delete' }] : []),
    ]);
    if (action === 'preview') {
      const preview = await previewResource(profile, resource.id);
      await view(ctx, resource.name, `${preview.path}\n\n${preview.text}${preview.truncated ? '\n[truncated]' : ''}`);
    }
    if (action === 'toggle') { await toggleResource(profile, resource.id, !resource.enabled); notify(); }
    if (action === 'edit') await edit(profile, resource);
    if (action === 'delete' && await ctx.ui.confirm('Delete owned copy?', resource.name)) { await removeResource(profile, resource.id); notify(); }
  };
  const resourcesPage = async (profile: string, type: ResourceType | null) => {
    while (true) {
      const current = await working(ctx, 'Reading resource metadata…', () => inventory(profile));
      const action = await choose<string>(ctx, `${profile} / ${type || 'All resources'} — staging`, [
        { label: '+ Import local resource copy', value: 'import' },
        ...(type === 'context' ? [{ label: '+ Create context', value: 'create' }] : []),
        ...current.resources.filter(resource => !type || resource.type === type).map(resource => ({ label: `[${resource.enabled ? 'x' : ' '}] ${resource.name} · ${resource.type} · ${resource.origin}`, value: resource.id })),
      ]);
      if (!action) return;
      await guard(async () => {
        if (action === 'import') {
          const kind = type || await choose<ResourceType>(ctx, 'Resource type', (['skills', 'extensions', 'prompts', 'themes', 'context'] as const).map(value => ({ label: value, value })));
          if (!kind) return;
          const path = await inputPath();
          if (path) { await importResource(profile, kind, path); notify(); }
        } else if (action === 'create') {
          const name = await ctx.ui.input('New context', 'Name without .md');
          if (!name) return;
          const text = await ctx.ui.editor(`Context: ${name}`, `# ${name}\n\n`);
          if (text !== undefined) { await createContext(profile, name, text); notify(); }
        } else {
          const resource = current.resources.find(item => item.id === action);
          if (resource) await resourcePage(profile, resource);
        }
      });
    }
  };
  const packagePage = async (profile: string, source: string) => {
    while (true) {
      const current = await inventory(profile);
      const pkg = current.packages.find(item => item.source === source);
      if (!pkg) return;
      const action = await choose(ctx, `${pkg.name || source} · ${pkg.version || 'local'} — staging`, [
        { label: pkg.enabled ? 'Disable package' : 'Enable package', value: 'toggle' },
        { label: 'Package details', value: 'details' }, { label: 'Update package', value: 'update' },
        { label: 'Uninstall package', value: 'remove' },
        ...current.resources.filter(item => item.origin === 'package' && item.source === source).map(item => ({ label: `[${item.enabled ? 'x' : ' '}] ${item.type}: ${item.name}`, value: item.id })),
      ]);
      if (!action) return;
      await guard(async () => {
        if (action === 'toggle') { await togglePackage(profile, source, !pkg.enabled); notify(); }
        else if (action === 'details') await view(ctx, 'Package details', JSON.stringify(pkg, null, 2));
        else if (action === 'update' || action === 'remove') await packageRun(profile, action, source);
        else {
          const resource = current.resources.find(item => item.id === action);
          if (resource) await resourcePage(profile, resource);
        }
      });
    }
  };
  const packagesPage = async (profile: string) => {
    while (true) {
      const current = await working(ctx, 'Reading packages…', () => inventory(profile));
      const action = await choose<string | InventoryPackage>(ctx, `${profile} / Packages — staging`, [
        { label: '+ Add package', value: 'add' }, { label: 'Update all packages', value: 'update' },
        ...current.packages.map(pkg => ({ label: `[${pkg.enabled ? 'x' : ' '}] ${pkg.name || pkg.source} ${pkg.version || ''}`, value: pkg })),
      ]);
      if (!action) return;
      await guard(async () => {
        if (action === 'add') {
          const source = await ctx.ui.input('Add package', 'npm:name@version, git:host/owner/repo, or a local path');
          if (!source) return;
          const target = source.startsWith('.') ? resolve(ctx.cwd, source) : source;
          await view(ctx, 'Package inspection', JSON.stringify(await working(ctx, 'Inspecting package…', () => inspectPackage(target)), null, 2));
          await packageRun(profile, 'add', target);
        } else if (action === 'update') await packageRun(profile, 'update');
        else if (typeof action !== 'string') await packagePage(profile, action.source);
      });
    }
  };
  const versionsPage = async (profile: string) => {
    const versions = await packageVersions(profile);
    const action = await choose(ctx, `Package generations · active: ${versions.active || 'legacy'} · previous: ${versions.previous || 'none'}`, [
      { label: 'View generation status', value: 'status' },
      ...(versions.previous ? [{ label: 'Restore previous package generation', value: 'restore' }] : []),
    ]);
    if (action === 'status') await view(ctx, 'Package generations', JSON.stringify(versions, null, 2));
    if (action === 'restore' && await ctx.ui.confirm('Restore previous staging packages?', 'Offline restore of packages and package filters only. Does not restore contexts, sessions or credentials. Publish afterward and restart Pi.')) {
      await working(ctx, 'Validating previous generation…', () => rollbackPackages(profile)); notify();
    }
  };
  const logsPage = async (profile: string) => {
    let files: string[] = [];
    try { files = (await readdir(join(profilePath(profile), '.operations'))).filter(name => name.endsWith('.log')).sort().reverse(); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    const file = await choose(ctx, 'Package logs — review before sharing', files.map(value => ({ label: value, value })));
    if (file) await view(ctx, file, await readFile(join(profilePath(profile), '.operations', file), 'utf8'));
  };
  const profilePage = async (profile: string) => {
    while (true) {
      const choices: Choice<string>[] = [
        { label: 'Use on next Pi start (publish snapshot)', value: 'publish' },
        { label: 'Packages', value: 'packages' }, { label: 'Skills', value: 'skills' },
        { label: 'Context files', value: 'context' }, { label: 'Extensions', value: 'extensions' },
        { label: 'Prompt templates', value: 'prompts' }, { label: 'Themes', value: 'themes' },
        { label: 'All resources', value: 'all' }, { label: 'Package generations / restore', value: 'versions' },
        { label: 'Package operation logs', value: 'logs' }, { label: 'Copy profile', value: 'copy' },
        { label: 'Delete staging profile', value: 'delete' },
      ];
      const action = await choose(ctx, `pi-manager / ${profile} — staging only`, choices);
      if (!action) return;
      await guard(async () => {
        if (action === 'publish') await publish(profile);
        else if (action === 'packages') await packagesPage(profile);
        else if (action === 'versions') await versionsPage(profile);
        else if (action === 'logs') await logsPage(profile);
        else if (action === 'copy') { const name = await ctx.ui.input('Copy profile', 'New name; no credentials, sessions or installs copied'); if (name) await copyProfile(profile, name); }
        else if (action === 'delete') {
          const name = await ctx.ui.input('Delete staging profile', `Type ${profile} to confirm. Deletes its sessions and credentials, not published snapshots.`);
          if (name === profile) await deleteProfile(profile);
        } else await resourcesPage(profile, action === 'all' ? null : action as ResourceType);
      });
      if (!(await listProfiles()).some(item => item.name === profile)) return;
    }
  };
  while (true) {
    const profiles = await listProfiles();
    const published = await publishedBundle();
    const state = await getState();
    const action = await choose(ctx, `pi-manager · loaded: ${loaded?.profile || 'manager only'} · next start: ${published?.profile || 'manager only'}`, [
      ...profiles.map(profile => ({ label: `${profile.name === state.defaultProfile ? '★ ' : ''}${profile.name}`, value: profile.name })),
      { label: '+ Create profile', value: ':create' },
      { label: 'Use manager only on next Pi start', value: ':clear' },
      { label: 'About / loading instructions', value: ':about' },
    ]);
    if (!action) return;
    await guard(async () => {
      if (action === ':create') { const name = await ctx.ui.input('New profile', 'Letters, numbers, dots, underscores and hyphens'); if (name) await createProfile(name); }
      else if (action === ':clear') await publish(null);
      else if (action === ':about') await view(ctx, 'About pi-manager', `This manager runs inside Pi. No nested Pi or second terminal UI.\n\nRegister ${BUNDLE_DIR} once with “pi install <path>” (or npm run install:pi in the checkout).\n\nChanges edit staging profiles. “Use on next Pi start” publishes a detached snapshot; restart Pi to load its extensions, skills, prompts, themes and context. Existing default/project resources remain in effect. External local packages are references only. No hot unloading, runtime registry changes or Pi source patches.`);
      else await profilePage(action);
    });
  }
}
