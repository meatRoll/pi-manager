import { resolve } from 'node:path';
import { getSettings, saveSettings } from './storage.js';
import { packageOperation } from './packages.js';
import { publishForPi, piAgentDir, publishedBundle } from './bundle.js';
import { isGitSource, sourceIdentity } from './declarations.js';
import { sourceOf } from './package-state.js';
import { unmanagedPackages } from './doctor.js';
import { resolveActiveProfile } from './cli-add.js';
import { errorMessage } from './errors.js';
/** Pi resolves relative local declarations against its agent directory, not the
 * caller's working directory, so re-stage local sources from there.
 */
function stagedSource(source, agentDir) {
    return source.startsWith('npm:') || isGitSource(source) ? source : resolve(agentDir, source);
}
export async function adoptUnmanaged(profile, entries, agentDir = piAgentDir()) {
    const result = { ok: true, profile, adopted: [], failed: [], published: null, requiresRestart: true };
    if (!entries.length)
        return result;
    const filters = new Map();
    for (const item of entries) {
        try {
            const staged = await packageOperation(profile, 'add', stagedSource(item.source, agentDir));
            result.adopted.push({ source: item.source, generation: staged.generation });
            if (item.identity)
                filters.set(item.identity, item.entry);
        }
        catch (error) {
            result.failed.push({ source: item.source, error: errorMessage(error) });
        }
    }
    // Filters, autoload and disabled state belong to the user, not to the package.
    // Apply them to the staged entries before publishing so adoption is invisible.
    if (result.adopted.length) {
        const settings = await getSettings(profile);
        let touched = false;
        settings.packages = (settings.packages || []).map(entry => {
            const original = filters.get(sourceIdentity(sourceOf(entry)) ?? '');
            if (!original || typeof original !== 'object')
                return entry;
            touched = true;
            return { ...original, source: sourceOf(entry) };
        });
        if (touched)
            await saveSettings(profile, settings);
    }
    if (result.adopted.length) {
        try {
            const bundle = await publishForPi(profile);
            result.published = { snapshot: bundle.id, declarations: bundle.declarations?.length ?? 0 };
        }
        catch (error) {
            result.ok = false;
            result.publishError = errorMessage(error);
        }
    }
    if (result.failed.length)
        result.ok = false;
    return result;
}
export const ADOPT_USAGE = `pi-manager adopt [--profile <name>] [--json] --yes

Stages every package that Pi declares directly but the active publication does
not, keeps its filters and disabled state, then publishes once. Publication
replaces the matching direct declarations in place, so nothing loads twice.

  --profile  preset to adopt into; default: saved default preset, else the only one
  --json     one JSON object: {ok, profile, adopted[], failed[], published}
  --yes      acknowledge third-party code and install scripts (required)

Nothing restarts. Roll back packages with: pi-manager package rollback <preset> --yes`;
function profileFlag(args) {
    let profile;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--json' || arg === '--yes')
            continue;
        const inline = arg.startsWith('--profile=') ? arg.slice('--profile='.length) : undefined;
        if (arg === '--profile' || inline !== undefined) {
            profile = inline ?? args[++index];
            if (!profile)
                throw new Error('--profile requires a preset name. See --help.');
            continue;
        }
        throw new Error(`Unknown adopt option: ${arg}. See --help.`);
    }
    return profile;
}
export async function runAdopt(args) {
    if (args.includes('--help') || args.includes('-h')) {
        process.stdout.write(`${ADOPT_USAGE}\n`);
        return;
    }
    const json = args.includes('--json');
    const profile = await resolveActiveProfile(profileFlag(args));
    if (!args.includes('--yes'))
        throw new Error('Pass --yes to acknowledge third-party package code and install scripts.');
    const agentDir = piAgentDir();
    const published = await publishedBundle().catch(() => null);
    const entries = await unmanagedPackages(published, agentDir);
    if (!entries.length) {
        if (json)
            process.stdout.write(`${JSON.stringify({ ok: true, profile, adopted: [], failed: [], published: null, requiresRestart: false }, null, 2)}\n`);
        else
            process.stdout.write(`Nothing to adopt: every package Pi declares is already managed by the active publication.\n`);
        return;
    }
    const result = await adoptUnmanaged(profile, entries, agentDir);
    if (json)
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else
        process.stdout.write(`${[
            ...(result.adopted.length
                ? [`Adopted ${result.adopted.length} package${result.adopted.length === 1 ? '' : 's'} into preset ${profile}: ${result.adopted.map(item => item.source).join(', ')}.`]
                : []),
            ...result.failed.map(item => `Failed ${item.source}: ${item.error}`),
            ...(result.published
                ? [`Published snapshot ${result.published.snapshot} for the next Pi start${result.published.declarations ? ` · ${result.published.declarations} package declaration${result.published.declarations === 1 ? '' : 's'} applied` : ''}.`]
                : []),
            ...(result.publishError ? [`Staged but not published: ${result.publishError}. Retry with: pi-manager publish --profile ${profile}`] : []),
            result.ok ? 'Restart Pi to load it; the running session is unchanged.' : 'Some packages remain declared directly; fix the errors above and rerun.',
        ].join('\n')}\n`);
    if (!result.ok)
        process.exitCode = 1;
}
