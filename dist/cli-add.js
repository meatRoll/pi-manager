import { getState, assertProfile, listProfiles } from './storage.js';
import { packageOperation } from './packages.js';
import { publishForPi } from './bundle.js';
import { errorMessage } from './errors.js';
import { plain } from './terminal.js';
const PROFILE_FLAG = '--profile';
export const ADD_USAGE = `pi-manager add <source>... [--profile <name>] [--publish] [--json] --yes

Stages each source in a preset and, with --publish, activates the snapshot for
the next Pi start. The running session keeps its current resources.

  <source>   npm:name@version, git:host/owner/repo@ref, or a local path
  --profile  preset to stage into; default: saved default preset, else the only one
  --publish  publish and activate the snapshot (never implied by --yes)
  --json     one JSON object: {ok, profile, staged[], published, publishError?}
  --yes      acknowledge third-party code and install scripts (required)

Project .pi settings are never written and Pi is never restarted.`;
export const PUBLISH_USAGE = `pi-manager publish [--profile <name>] [--json]

Publishes the active preset and activates it for the next Pi start: the same
transaction as pressing P in /manager.`;
export function parseAddOptions(args) {
    const sources = [];
    const options = { sources, publish: false, json: false, yes: false };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--yes') {
            options.yes = true;
            continue;
        }
        if (arg === '--json') {
            options.json = true;
            continue;
        }
        if (arg === '--publish') {
            options.publish = true;
            continue;
        }
        const inline = arg.startsWith(`${PROFILE_FLAG}=`) ? arg.slice(PROFILE_FLAG.length + 1) : undefined;
        if (arg === PROFILE_FLAG || inline !== undefined) {
            const value = inline ?? args[++index];
            if (!value)
                throw new Error(`${PROFILE_FLAG} requires a preset name. See --help.`);
            options.profile = value;
            continue;
        }
        if (arg.startsWith('-'))
            throw new Error(`Unknown add option: ${arg}. See --help.`);
        sources.push(arg);
    }
    if (!sources.length)
        throw new Error('add needs at least one package source: npm:name@version, git:host/owner/repo@ref, or a local path. See --help.');
    return options;
}
/** The preset a command operates on: explicit flag, then the saved default, then
 * the only existing preset. Never invents a profile.
 */
export async function resolveActiveProfile(requested) {
    if (requested) {
        await assertProfile(requested);
        return requested;
    }
    const state = await getState();
    if (state.defaultProfile) {
        await assertProfile(state.defaultProfile);
        return state.defaultProfile;
    }
    const profiles = await listProfiles();
    if (profiles.length === 1)
        return profiles[0].name;
    throw new Error(profiles.length
        ? `No default preset. Pass ${PROFILE_FLAG} <name>. Available: ${profiles.map(profile => profile.name).join(', ')}`
        : 'No staging preset exists yet. Create one in /manager, or run: pi-manager profile create mine');
}
function emitJson(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function reportLines(report) {
    const lines = report.staged.map(item => [
        `Staged ${item.source} in preset ${report.profile}; generation ${item.generation}.`,
        ...(item.missingBaseline.length ? [`No restorable baseline: missing ${item.missingBaseline.join(', ')}.`] : []),
        `Log: ${item.log}`,
    ].join('\n'));
    if (report.published) {
        lines.push(`Published snapshot ${report.published.snapshot} for the next Pi start${report.published.declarations ? ` · ${report.published.declarations} package declaration${report.published.declarations === 1 ? '' : 's'} applied` : ''}.`);
        lines.push(`Restart Pi to load it. Undo with: pi-manager package rollback ${report.profile} --yes`);
    }
    else if (report.publishError) {
        lines.push(`Staged but not published: ${report.publishError}`);
        lines.push(`Staging is intact. Fix the error, then run: pi-manager publish ${PROFILE_FLAG} ${report.profile}`);
    }
    else {
        lines.push('Staged only. Publish from /manager or rerun with --publish; Pi is unchanged until then.');
    }
    return lines.join('\n');
}
/** Stage one or more sources, optionally publish, and report the resulting
 * generation and snapshot. `--yes` acknowledges third-party code only; it never
 * implies --publish.
 */
export async function runAdd(args) {
    if (args.includes('--help') || args.includes('-h')) {
        process.stdout.write(`${ADD_USAGE}\n`);
        return;
    }
    const json = args.includes('--json');
    let options;
    try {
        options = parseAddOptions(args);
    }
    catch (error) {
        if (json) {
            emitJson({ ok: false, stage: 'arguments', error: errorMessage(error) });
            process.exitCode = 1;
            return;
        }
        throw error;
    }
    if (!options.yes)
        throw new Error('Pass --yes to acknowledge third-party package code and install scripts. Staging alone still executes install scripts.');
    const profile = await resolveActiveProfile(options.profile);
    const staged = [];
    for (const source of options.sources) {
        const result = await packageOperation(profile, 'add', source, options.json
            ? {}
            : { onOutput: text => process.stdout.write(plain(text)) });
        staged.push({ source, generation: result.generation, previous: result.previous, log: result.logPath, missingBaseline: result.missingBaseline });
    }
    const report = { ok: true, profile, staged, published: null, requiresRestart: true };
    if (options.publish) {
        try {
            const bundle = await publishForPi(profile);
            report.published = { snapshot: bundle.id, profile: bundle.profile, declarations: bundle.declarations?.length ?? 0 };
        }
        catch (error) {
            report.ok = false;
            report.publishError = errorMessage(error);
        }
    }
    if (options.json)
        emitJson(report);
    else
        process.stdout.write(`${reportLines(report)}\n`);
    if (!report.ok)
        process.exitCode = 1;
}
/** Publish the active preset without touching packages. Same transaction the
 * `/manager` **P** key runs, so a failed `add --publish` stays recoverable.
 */
export async function runPublish(args) {
    if (args.includes('--help') || args.includes('-h')) {
        process.stdout.write(`${PUBLISH_USAGE}\n`);
        return;
    }
    const json = args.includes('--json');
    let profile;
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--json')
            continue;
        const inline = arg.startsWith(`${PROFILE_FLAG}=`) ? arg.slice(PROFILE_FLAG.length + 1) : undefined;
        if (arg === PROFILE_FLAG || inline !== undefined) {
            profile = inline ?? args[++index];
            if (!profile)
                throw new Error(`${PROFILE_FLAG} requires a preset name. See --help.`);
            continue;
        }
        throw new Error(`Unknown publish option: ${arg}. See --help.`);
    }
    const active = await resolveActiveProfile(profile);
    const bundle = await publishForPi(active);
    const report = { ok: true, profile: active, snapshot: bundle.id, declarations: bundle.declarations?.length ?? 0, requiresRestart: true };
    if (json)
        emitJson(report);
    else
        process.stdout.write(`${[
            `Published preset ${active} as snapshot ${bundle.id} for the next Pi start.`,
            ...(report.declarations ? [`Declared ${report.declarations} package${report.declarations === 1 ? '' : 's'} at their published refs.`] : []),
            'Restart Pi to load it. Nothing changed in the running session.',
        ].join('\n')}\n`);
}
