#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MANAGER_HOME, createProfile, copyProfile, deleteProfile, listProfiles, setDefaultProfile, runPi, assertProfile,
} from './core.js';
import { packageOperation, inspectPackage, togglePackage, packageVersions, rollbackPackages } from './packages.js';
import { inventory, previewResource, toggleResource, importResource, createContext, removeResource, parseResourceType } from './resources.js';
import { openTui, editResource } from './tui.js';
import { plain } from './terminal.js';
import { errorCode, errorMessage } from './errors.js';
import { VERSION } from './version.js';
import { installPiExtension } from './install-pi.js';
import { migratePiPackages } from './migration.js';
import { selfUpdate } from './self-update.js';

const HELP = `pi-manager ${VERSION} — Pi resource manager extension

Primary interface: type /manager INSIDE Pi. This CLI is optional/legacy.
  pi-manager install --yes                       Register extension bundle, then restart Pi
  pi-manager self-update --yes                   git pull the manager checkout, republish, restart Pi
  pi-manager migrate <profile> [agent-dir] --yes  Copy installed Pi packages into an empty staging profile

  pi-manager tui                                 Legacy standalone maintenance UI
  pi-manager profile list
  pi-manager profile create <name>
  pi-manager profile copy <from> <to>             Excludes auth, sessions, installed packages
  pi-manager profile use <name>                   Set manager default only
  pi-manager profile delete <name> --yes          Deletes its sessions and credentials too
  pi-manager profile run <name> [-- <pi args>]

  pi-manager package inspect <npm:spec|git:spec|path>
  pi-manager package add <profile> <source> --yes
  pi-manager package remove <profile> <source> --yes
  pi-manager package update <profile> [source] --yes
  pi-manager package enable|disable <profile> <source>
  pi-manager package list <profile>
  pi-manager package versions <profile>          Current/previous package generation
  pi-manager package rollback <profile> --yes    Restore previous packages (profile stopped)

  pi-manager resource list <profile> [type] [--json]
  pi-manager resource import <profile> <type> <path> [name]
  pi-manager resource preview|edit|enable|disable <profile> <id>
  pi-manager resource remove <profile> <id> --yes

  pi-manager context list <profile>
  pi-manager context create <profile> <name> [text]
  pi-manager context import <profile> <path> [name]
  pi-manager context preview|edit|enable|disable <profile> <name>
  pi-manager context remove <profile> <name> --yes
  pi-manager logs <profile> [filename]

Types: skills, extensions, prompts, themes, context
State: ${MANAGER_HOME}
Environment: PI_MANAGER_HOME, PI_MANAGER_PUBLISH_DIR, PI_MANAGER_PI, PI_MANAGER_SDK_PATH, PI_MANAGER_EDITOR

Changes apply next launch. No live unload or mutation of the default Pi/project config.
--yes acknowledges package code/install-script execution or destructive deletion.
`;
const requireValue = (value: string | undefined, label: string): string => { if (!value) throw new Error(`${label} is required. See --help.`); return value; };
const acknowledge = (args: string[]) => { if (!args.includes('--yes')) throw new Error('Explicit --yes required. Review third-party code and scripts, or the data being deleted.'); };
const print = (text: unknown) => console.log(plain(text));

async function contextId(profile: string, name: string) {
  const item = (await inventory(profile)).resources.find(resource => resource.type === 'context' && (resource.name === name || resource.id === name));
  if (!item) throw new Error(`Context not found: ${name}`);
  return item.id;
}

export async function main(args: string[]) {
  const [command, subcommand, ...raw] = args;
  if (!command) return print(HELP);
  if (command === 'tui') return openTui();
  if (['help', '--help', '-h'].includes(command)) return print(HELP);
  if (['--version', '-v'].includes(command)) return print(VERSION);
  const rest = raw.filter(value => value !== '--yes' && value !== '--json');
  if (command === 'install') { acknowledge(args); return installPiExtension(true); }
  if (command === 'self-update') {
    acknowledge(args);
    const result = await selfUpdate();
    return print([
      result.changed
        ? `Updated ${result.root}: ${result.before} → ${result.after}.`
        : `Already up to date: ${result.root} at ${result.after}.`,
      result.republished ? `Republished preset ${result.republished} for the next Pi start.` : 'No published preset to re-point.',
      ...(result.republishError ? [`Republish failed: ${result.republishError}`] : []),
      'Restart Pi to load the updated manager.',
    ].join('\n'));
  }
  if (command === 'migrate') {
    acknowledge(args);
    const target = requireValue(subcommand, 'Profile');
    if (rest.length > 1) throw new Error('Expected at most one source agent directory. See --help.');
    const result = await migratePiPackages(target, rest[0]);
    return print([
      `Imported ${result.imported.length} packages into staging profile ${result.profile}; generation ${result.generation}.`,
      `Source Pi settings unchanged: ${result.sourceAgentDir}`,
      ...(result.externalLocal.length ? [`External local references: ${result.externalLocal.join(', ')}`] : []),
      ...(result.skipped.length ? [`Skipped manager bundle: ${result.skipped.join(', ')}`] : []),
      'Verify the import before publishing. Original declarations remain active; explicitly remove duplicates only after verification, before using the published copies.',
    ].join('\n'));
  }
  const [profileInput, value, extra, label] = rest;
  if (command === 'profile') {
    if (subcommand === 'list') {
      for (const item of await listProfiles()) print(`${item.isDefault ? '*' : ' '} ${item.name}\t${item.path}`);
      return;
    }
    const profile = requireValue(profileInput, 'Profile');
    if (subcommand === 'create') return print(await createProfile(profile));
    if (subcommand === 'copy') return print(await copyProfile(profile, requireValue(value, 'Destination')));
    if (subcommand === 'use') { await setDefaultProfile(profile); return print(`Default: ${profile}`); }
    if (subcommand === 'delete') { acknowledge(raw); await deleteProfile(profile); return print(`Deleted ${profile}`); }
    if (subcommand === 'run') {
      const forwarded = raw.slice(1);
      if (forwarded[0] === '--') forwarded.shift();
      if (forwarded[0] && !forwarded[0].startsWith('-')) throw new Error('Only Pi session arguments are accepted. Package and self-update commands are not allowed here.');
      process.exitCode = await runPi(profile, forwarded);
      return;
    }
  }
  if (command === 'package') {
    if (subcommand === 'inspect') return print(JSON.stringify(await inspectPackage(requireValue(profileInput, 'Source')), null, 2));
    const profile = requireValue(profileInput, 'Profile'); await assertProfile(profile);
    if (subcommand === 'versions') return print(JSON.stringify(await packageVersions(profile), null, 2));
    if (subcommand === 'rollback') {
      acknowledge(raw);
      const restored = await rollbackPackages(profile);
      return print(`Restored package generation ${restored.generation} for next launch. Log: ${restored.logPath}`);
    }
    if (subcommand === 'list') {
      for (const pkg of (await inventory(profile)).packages) print(`[${pkg.enabled ? 'x' : ' '}] ${pkg.source}\t${pkg.version || ''}`);
      return;
    }
    if (['enable', 'disable'].includes(subcommand)) {
      await togglePackage(profile, requireValue(value, 'Source'), subcommand === 'enable');
      return print('Saved for next launch.');
    }
    if (['add', 'remove', 'update'].includes(subcommand)) {
      acknowledge(raw);
      if (subcommand !== 'update') requireValue(value, 'Source');
      const result = await packageOperation(profile, subcommand, value, { onOutput: text => process.stdout.write(plain(text)) });
      return print(`Saved generation ${result.generation} for next launch.${result.missingBaseline?.length ? ` No restorable baseline: missing ${result.missingBaseline.join(', ')}.` : ''} Log: ${result.logPath}`);
    }
  }
  if (command === 'resource' || command === 'context') {
    const context = command === 'context';
    const profile = requireValue(profileInput, 'Profile'); await assertProfile(profile);
    if (subcommand === 'list') {
      const current = await inventory(profile);
      const filtered = current.resources.filter(resource => !(context || value) || resource.type === (context ? 'context' : value));
      if (raw.includes('--json')) return console.log(JSON.stringify(filtered, null, 2));
      for (const resource of filtered) print(`${resource.id} [${resource.enabled ? 'x' : ' '}] ${resource.type}\t${resource.displayName}\t${resource.owned ? 'owned' : resource.origin}\t${resource.path}`);
      return;
    }
    if (subcommand === 'import') return print(await importResource(profile, context ? 'context' : parseResourceType(requireValue(value, 'Type')), requireValue(context ? value : extra, 'Path'), context ? extra : label));
    if (context && subcommand === 'create') return print(await createContext(profile, requireValue(value, 'Name'), extra || ''));
    const id = context ? await contextId(profile, requireValue(value, 'Context name')) : requireValue(value, 'Resource id');
    if (subcommand === 'preview') {
      const preview = await previewResource(profile, id);
      return print(preview.text + (preview.truncated ? '\n[preview truncated]' : ''));
    }
    if (subcommand === 'edit') {
      const resource = (await inventory(profile)).resources.find(item => item.id === id);
      if (!resource?.owned) throw new Error('Only manager-owned resources can be edited. Import a copy first.');
      return editResource(profile, resource);
    }
    if (['enable', 'disable'].includes(subcommand)) { await toggleResource(profile, id, subcommand === 'enable'); return print('Saved for next launch.'); }
    if (subcommand === 'remove') { acknowledge(raw); await removeResource(profile, id); return print('Removed owned resource.'); }
  }
  if (command === 'logs') {
    const root = await assertProfile(requireValue(subcommand, 'Profile'));
    if (profileInput) {
      if (!/^[A-Za-z0-9.-]+\.log$/.test(profileInput)) throw new Error('Invalid log filename');
      return print(await readFile(join(root, '.operations', profileInput), 'utf8'));
    }
    try { return print((await readdir(join(root, '.operations'))).sort().reverse().join('\n')); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; return; }
  }
  throw new Error('Invalid command. See pi-manager --help.');
}

main(process.argv.slice(2)).catch(error => {
  console.error(`pi-manager: ${plain(errorMessage(error))}`);
  process.exitCode = 1;
});
