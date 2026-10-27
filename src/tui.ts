import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminal } from './terminal.js';
import type { MenuEntry } from './terminal.js';
import { errorCode, errorMessage } from './errors.js';
import type { Resource, ResourceType, InventoryPackage, ProfileSummary } from './types.js';

interface TuiEntry extends MenuEntry {
  value?: string;
  resource?: Resource;
  pkg?: InventoryPackage;
  profile?: ProfileSummary;
}
import { listProfiles, getState, createProfile, copyProfile, deleteProfile, setDefaultProfile, profilePath, runPi, run } from './core.js';
import { packageOperation, inspectPackage, togglePackage, packageVersions, rollbackPackages } from './packages.js';
import { inventory, previewResource, toggleResource, importResource, createContext, writeResource, removeResource, parseResourceType, originLabel } from './resources.js';

export async function editResource(profile: string, resource: Resource, ui?: Terminal) {
  const preview = await previewResource(profile, resource.id);
  if (preview.truncated) throw new Error('File is too large for in-manager editing');
  const temporary = await mkdtemp(join(tmpdir(), 'pi-manager-edit-'));
  try {
    const path = join(temporary, resource.type === 'themes' ? 'resource.json' : resource.type === 'extensions' ? resource.name : 'resource.md');
    await writeFile(path, preview.text, { mode: 0o600 });
    // Deliberately no shell evaluation. For editors needing arguments, use a
    // small wrapper executable and set PI_MANAGER_EDITOR to its path.
    const editor = process.env.PI_MANAGER_EDITOR || process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
    const action = () => run(editor, [path]);
    const code = ui ? await ui.suspend(action) : await action();
    if (code !== 0) throw new Error(`Editor exited ${code}; resource unchanged`);
    await writeResource(profile, resource.id, await readFile(path, 'utf8'));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function openTui() {
  const ui = new Terminal(); ui.start();
  const notice = (text: string) => { ui.queue = []; return ui.view('Notice', text); };
  const guard = async (action: () => unknown | Promise<unknown>) => { try { return await action(); } catch (error) { ui.queue = []; await ui.view('Error', errorMessage(error)); } };
  const packageRun = async (profile: string, command: string, source?: string) => {
    let lines: string[] = [];
    const result = await packageOperation(profile, command, source, { onOutput: text => {
      lines = [...lines, ...text.split(/\r?\n/)].slice(-100);
      ui.draw(`${command} package`, lines.slice(-Math.max(1, (process.stdout.rows || 24) - 5)), ' Running… package changes apply next launch.');
    } });
    await notice(`Saved package generation: ${result.generation}\nPrevious: ${result.previous || 'none (no complete baseline)'}\nChanges apply next launch.\nLog: ${result.logPath}`);
  };
  const addPackage = async (profile: string) => {
    const source = await ui.inputText('Add package', 'npm:package@version, git:host/owner/repo, or an absolute local path');
    if (!source) return;
    const info = await inspectPackage(source);
    await ui.view('Package inspection', JSON.stringify(info, null, 2));
    if (await ui.confirm('Install package?', 'Third-party extensions and install scripts execute with your account permissions.')) await packageRun(profile, 'add', source);
  };
  const packagePage = async (profile: string, pkg: InventoryPackage) => {
    while (true) {
      const current = await inventory(profile);
      const configured = current.packages.find(item => item.source === pkg.source);
      if (!configured) return;
      pkg = configured;
      const owned = current.resources.filter(resource => resource.origin === 'package' && resource.source === pkg.source);
      const result = await ui.select<TuiEntry>(pkg.displayName, [
        { label: pkg.enabled ? 'Disable package' : 'Enable package', value: 'toggle' },
        { label: 'View package details', value: 'detail' },
        { label: 'Update package', value: 'update' },
        { label: 'Uninstall package', value: 'remove' },
        ...owned.map(resource => ({ label: `[${resource.enabled ? 'x' : ' '}] ${resource.type}: ${resource.displayName}`, resource, toggle: true })),
      ], `${pkg.version || 'local'} · ${pkg.enabled ? 'enabled' : 'disabled'} · next-launch configuration`);
      if (!result) return;
      const resource = result.entry.resource;
      if (resource) {
        if (result.action === 'toggle') await guard(() => toggleResource(profile, resource.id, !resource.enabled));
        else await resourcePage(profile, resource);
      } else if (result.entry.value === 'toggle') await guard(() => togglePackage(profile, pkg.source, !pkg.enabled));
      else if (result.entry.value === 'detail') await ui.view('Package details', JSON.stringify(pkg, null, 2));
      else if (result.entry.value === 'update') await guard(() => packageRun(profile, 'update', pkg.source));
      else if (result.entry.value === 'remove' && await ui.confirm('Uninstall?', pkg.source)) { await guard(() => packageRun(profile, 'remove', pkg.source)); return; }
    }
  };
  const resourcePage = async (profile: string, resource: Resource) => {
    const result = await ui.select(resource.displayName, [
      { label: 'Preview', value: 'preview' },
      ...(resource.origin === 'global' ? [] : [{ label: resource.enabled ? 'Disable' : 'Enable', value: 'toggle' }]),
      ...(resource.owned ? [{ label: 'Edit with external editor', value: 'edit' }, { label: 'Delete owned copy', value: 'delete' }] : []),
    ], `${resource.type} · ${originLabel(resource.origin)} · ${resource.owned ? 'manager-owned' : 'external read-only'}\n${resource.path}`);
    if (!result) return;
    await guard(async () => {
      if (result.entry.value === 'preview') {
        const preview = await previewResource(profile, resource.id);
        await ui.view(resource.displayName, `${preview.path}\n\n${preview.text}${preview.truncated ? '\n[preview truncated]' : ''}`);
      } else if (result.entry.value === 'toggle') await toggleResource(profile, resource.id, !resource.enabled);
      else if (result.entry.value === 'edit') await editResource(profile, resource, ui);
      else if (result.entry.value === 'delete' && await ui.confirm('Delete owned resource?', resource.displayName)) await removeResource(profile, resource.id);
    });
  };
  const resourcesPage = async (profile: string, type: ResourceType | null) => {
    while (true) {
      ui.draw('Resources', [' Reading Pi resource metadata (extensions are not executed)…']);
      const current = await inventory(profile);
      ui.queue = [];
      const entries = current.resources.filter(resource => !type || resource.type === type);
      const result = await ui.select<TuiEntry>(type || 'All resources', [
        { label: '+ Import local resource', value: 'import' },
        ...(type === 'context' ? [{ label: '+ Create context', value: 'create' }] : []),
        ...entries.map(resource => ({ label: `[${resource.enabled ? 'x' : ' '}] ${resource.displayName}`, detail: `${resource.type} · ${originLabel(resource.origin)}${resource.owned ? ' · owned' : ''}`, resource, toggle: resource.origin !== 'global' })),
      ], 'Space toggles next-launch enablement. Package/external originals are read-only.');
      if (!result) return;
      const resource = result.entry.resource;
      if (resource) {
        if (result.action === 'toggle') await guard(() => toggleResource(profile, resource.id, !resource.enabled));
        else await resourcePage(profile, resource);
      } else if (result.entry.value === 'create') {
        const name = await ui.inputText('New context', 'Name (without .md)');
        if (name) await guard(async () => {
          await createContext(profile, name, `# ${name}\n\n`);
          const resource = (await inventory(profile)).resources.find(item => item.type === 'context' && item.name === name);
          if (!resource) throw new Error('Created context was not discovered');
          await editResource(profile, resource, ui);
        });
      } else {
        const kind = type || (await ui.select('Resource type', (['skills', 'extensions', 'prompts', 'themes', 'context'] as const).map(value => ({ label: value, value }))))?.entry.value;
        if (!kind) continue;
        const source = await ui.inputText('Import resource', 'Path to a skill/extension directory or a Markdown/JSON/module file. A copy is made.');
        if (source) await guard(() => importResource(profile, kind, source));
      }
    }
  };
  const logsPage = async (profile: string) => {
    let files: string[];
    try { files = (await readdir(join(profilePath(profile), '.operations'))).filter(name => name.endsWith('.log')).sort().reverse(); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; files = []; }
    const result = await ui.select('Package operation logs', files.map(file => ({ label: file, value: file })), 'Logs may contain registry diagnostics. Review before sharing.');
    if (result) await ui.view(result.entry.value, await readFile(join(profilePath(profile), '.operations', result.entry.value), 'utf8'));
  };
  const versionsPage = async (profile: string) => {
    const versions = await packageVersions(profile);
    const selected = await ui.select('Package generations', [
      { label: 'View generation status', value: 'status' },
      ...(versions.previous ? [{ label: 'Restore previous package generation', value: 'restore' }] : []),
    ], `Active: ${versions.active || 'legacy layout'} · Previous: ${versions.previous || 'none'}`);
    if (selected?.entry.value === 'status') await ui.view('Package generations', JSON.stringify(versions, null, 2));
    if (selected?.entry.value === 'restore' && await ui.confirm('Restore previous packages?', 'Requires stopped profile. Restores packages and package filters only; not contexts, sessions or credentials.')) {
      const restored = await rollbackPackages(profile);
      await notice(`Restored ${restored.generation} for the next launch.\nLog: ${restored.logPath}`);
    }
  };
  const profilePage = async (profile: string) => {
    while (true) {
      const result = await ui.select(profile, [
        { label: 'Run Pi', value: 'run' }, { label: 'Packages', value: 'packages' },
        { label: 'Skills', value: 'skills' }, { label: 'Context files', value: 'context' },
        { label: 'Extensions', value: 'extensions' }, { label: 'Prompt templates', value: 'prompts' },
        { label: 'Themes', value: 'themes' }, { label: 'All resources', value: 'all' },
        { label: 'Package generations / restore', value: 'versions' },
        { label: 'Package operation logs', value: 'logs' }, { label: 'Set as default', value: 'default' },
        { label: 'Copy profile (no credentials or sessions)', value: 'copy' },
        { label: 'Delete profile', value: 'delete' },
      ], profilePath(profile));
      if (!result) return;
      const value = result.entry.value;
      await guard(async () => {
        if (value === 'run') await ui.suspend(() => runPi(profile));
        else if (value === 'default') await setDefaultProfile(profile);
        else if (value === 'copy') { const name = await ui.inputText('Copy profile', 'New profile name'); if (name) await copyProfile(profile, name); }
        else if (value === 'logs') await logsPage(profile);
        else if (value === 'versions') await versionsPage(profile);
        else if (value === 'delete') {
          const name = await ui.inputText('Delete profile', 'This deletes its credentials and sessions. Type the exact profile name to confirm.');
          if (name === profile) await deleteProfile(profile);
        } else if (value === 'packages') {
          while (true) {
            const current = await inventory(profile);
            const choice = await ui.select<TuiEntry>('Packages', [{ label: '+ Add package', value: 'add' }, { label: 'Update all packages', value: 'update' },
              ...current.packages.map(pkg => ({ label: `[${pkg.enabled ? 'x' : ' '}] ${pkg.displayName}`, detail: pkg.version, pkg, toggle: true })),
            ], 'Installed ≠ enabled. All changes apply on the next launch.');
            if (!choice) break;
            await guard(async () => {
              if (choice.entry.value === 'add') await addPackage(profile);
              else if (choice.entry.value === 'update') await packageRun(profile, 'update');
              else if (choice.entry.pkg && choice.action === 'toggle') await togglePackage(profile, choice.entry.pkg.source, !choice.entry.pkg.enabled);
              else if (choice.entry.pkg) await packagePage(profile, choice.entry.pkg);
            });
          }
        } else await resourcesPage(profile, value === 'all' ? null : parseResourceType(value));
      });
      if (value === 'delete' && !(await listProfiles()).some(item => item.name === profile)) return;
    }
  };
  try {
    while (true) {
      const profiles = await listProfiles();
      const state = await getState();
      const result = await ui.select<TuiEntry>('Profiles', [
        ...profiles.map(profile => ({ label: `${profile.name === state.defaultProfile ? '★ ' : ''}${profile.name}`, detail: profile.path, profile })),
        { label: '+ Create profile', value: 'create' }, { label: 'Quit', value: 'quit' },
      ], 'Independent profiles. Default Pi and project .pi files are not managed.');
      if (!result || result.entry.value === 'quit') return;
      await guard(async () => {
        if (result.entry.profile) await profilePage(result.entry.profile.name);
        else { const name = await ui.inputText('New profile', 'Letters, numbers, dots, underscores and hyphens'); if (name) await createProfile(name); }
      });
    }
  } finally { ui.stop(); }
}
