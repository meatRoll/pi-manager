import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MANAGER_HOME, PROFILES_DIR, PUBLISH_DIR, PUBLISH_DIR_SOURCE, listProfiles, profilePath, validatePublishDir } from './storage.js';
import { BUNDLE_DIR, assertPublishLocation, isManagerOrBundle, piAgentDir, publishedBundle } from './bundle.js';
import { bundleDeclarations, looksLikeManager, staleBundleDeclarations } from './install-pi.js';
import { isGitSource, sourceIdentity } from './declarations.js';
import { sourceOf } from './package-state.js';
import { errorCode, errorMessage } from './errors.js';
async function agentPackages(agentDir) {
    const path = join(agentDir, 'settings.json');
    try {
        const settings = JSON.parse(await readFile(path, 'utf8'));
        return Array.isArray(settings.packages) ? settings.packages : [];
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return [];
        throw new Error(`Cannot read ${path}: ${errorMessage(error)}`);
    }
}
/** Pi's matching identity for a declaration, with local paths resolved against
 * the settings file that declared them rather than the manager home.
 */
function identityOf(entry, baseDir) {
    const source = sourceOf(entry);
    if (source.startsWith('npm:') || isGitSource(source))
        return sourceIdentity(source);
    return sourceIdentity(resolve(baseDir, source));
}
/** Classify Pi's own declarations against a publication. Both the doctor report
 * and `adopt` use this, so what is reported is exactly what gets adopted.
 */
export function comparePackages(installed, published, agentDir) {
    const pinned = new Map((published?.declarations ?? []).map(item => [item.identity, item]));
    const drift = { unmanaged: [], drifted: [] };
    for (const entry of installed) {
        if (isManagerOrBundle(entry, agentDir))
            continue;
        const source = sourceOf(entry);
        if (looksLikeManager(source))
            continue;
        const identity = identityOf(entry, agentDir);
        const expected = identity ? pinned.get(identity) : undefined;
        if (expected) {
            if (source !== expected.pinned)
                drift.drifted.push({ source, pinned: expected.pinned });
            continue;
        }
        drift.unmanaged.push({ source, entry, ...(identity ? { identity } : {}) });
    }
    return drift;
}
export async function unmanagedPackages(published, agentDir = piAgentDir()) {
    return comparePackages(await agentPackages(agentDir), published, agentDir).unmanaged;
}
function activeProfile(profiles, requested) {
    if (requested) {
        return profiles.some(item => item.name === requested)
            ? { profile: requested }
            : { profile: null, finding: { level: 'error', code: 'profile-unknown', message: `Preset not found: ${requested}`, hint: `Available: ${profiles.map(item => item.name).join(', ') || '(none)'}` } };
    }
    const saved = profiles.find(item => item.isDefault)?.name;
    if (saved)
        return { profile: saved };
    if (profiles.length === 1)
        return { profile: profiles[0].name };
    return {
        profile: null,
        finding: profiles.length
            ? { level: 'warn', code: 'profile-default-missing', message: 'No default preset, so commands must pass --profile.', hint: `Available: ${profiles.map(item => item.name).join(', ')}` }
            : { level: 'warn', code: 'profile-missing', message: 'No staging preset exists yet.', hint: 'Open /manager and choose + Create profile, or run: pi-manager profile create mine' },
    };
}
export const DOCTOR_USAGE = `pi-manager doctor [--profile <name>] [--json]

Read-only report of the manager → publication → Pi chain: publish directory,
preset, snapshot, package declarations written outside the manager, leftover
locks, and a bundle registered for another PI_MANAGER_HOME. Warnings keep exit
code 0; blocking errors exit non-zero.`;
export function doctorText(report) {
    const order = ['error', 'warn', 'ok'];
    const lines = [
        `manager home  ${report.managerHome}`,
        `publish dir   ${report.publishDir}`,
        `preset        ${report.profile ?? '(none)'}`,
        `publication   ${report.publication ?? '(none)'}`,
        '',
        ...[...report.findings]
            .sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level))
            .map(finding => `${finding.level.padEnd(5)} ${finding.code.padEnd(22)} ${finding.message}${finding.hint ? `\n      → ${finding.hint}` : ''}`),
    ];
    const errors = report.findings.filter(finding => finding.level === 'error').length;
    const warnings = report.findings.filter(finding => finding.level === 'warn').length;
    lines.push('', report.ok
        ? `No blocking problems${warnings ? `; ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`
        : `${errors} problem${errors === 1 ? '' : 's'} must be fixed before the next Pi start.`);
    return lines.join('\n');
}
export async function doctor(input = {}) {
    const findings = [];
    const add = (level, code, message, hint) => findings.push({ level, code, message, ...(hint ? { hint } : {}) });
    const report = { ok: false, managerHome: MANAGER_HOME, publishDir: PUBLISH_DIR, profile: null, publication: null, findings, unmanaged: [] };
    if (!existsSync(MANAGER_HOME)) {
        add('error', 'manager-home-missing', `No manager data at ${MANAGER_HOME}.`, 'Install it first: pi-manager install --yes');
        return report;
    }
    try {
        assertPublishLocation();
        validatePublishDir();
        add('ok', 'publish-dir', `Reachable (${PUBLISH_DIR_SOURCE}).`);
    }
    catch (error) {
        add('error', 'publish-dir', errorMessage(error), 'pi-manager config publish-dir <path>');
    }
    let profiles = [];
    try {
        profiles = await listProfiles();
    }
    catch (error) {
        add('error', 'manager-home-invalid', errorMessage(error), 'Fix PI_MANAGER_HOME or the saved publish directory: pi-manager config publish-dir <path>');
    }
    const active = activeProfile(profiles, input.profile);
    report.profile = active.profile;
    if (active.finding)
        add(active.finding.level, active.finding.code, active.finding.message, active.finding.hint);
    else
        add('ok', 'profile', `Preset ${active.profile} is available.`);
    if (active.profile && existsSync(join(profilePath(active.profile), '.lock'))) {
        add('warn', 'profile-locked', `Preset ${active.profile} has a leftover .lock file; package changes will be refused.`, `Verify no Pi or package process uses ${join(PROFILES_DIR, active.profile)} before removing ${join(profilePath(active.profile), '.lock')}`);
    }
    let published = null;
    try {
        published = await publishedBundle();
    }
    catch (error) {
        add('error', 'publication-unreadable', `Cannot read ${join(BUNDLE_DIR, 'package.json')}: ${errorMessage(error)}`, 'Republish with: pi-manager publish');
    }
    const agentDir = piAgentDir();
    if (!published) {
        add('warn', 'publication-missing', 'Nothing is published, so the next Pi start loads none of this preset.', `Publish it: pi-manager publish --profile ${active.profile ?? '<name>'}`);
    }
    else {
        report.publication = published.id;
        if (published.managerHome !== MANAGER_HOME) {
            add('error', 'manager-home-drift', `The registered bundle belongs to ${published.managerHome}, not ${MANAGER_HOME}.`, 'Reinstall the manager for this home: pi-manager install --yes');
        }
        if (!existsSync(join(BUNDLE_DIR, '.snapshots', published.id))) {
            add('error', 'snapshot-missing', `Snapshot ${published.id} is not on disk.`, 'Republish with: pi-manager publish');
        }
        else {
            add('ok', 'publication', `Snapshot ${published.id} is present.`);
        }
        if (published.profile && active.profile && published.profile !== active.profile) {
            add('warn', 'profile-drift', `Published preset is ${published.profile}, active preset is ${active.profile}.`, `Publish to switch: pi-manager publish --profile ${active.profile}`);
        }
        if (!published.profile)
            add('warn', 'publication-manager-only', 'The active publication declares no packages (manager-only mode).');
    }
    let declarations = [];
    if (published?.declarations?.length) {
        declarations = published.declarations.map(item => ({ identity: item.identity, pinned: item.pinned, source: item.source }));
    }
    try {
        const drift = comparePackages(await agentPackages(agentDir), published, agentDir);
        report.unmanaged = drift.unmanaged;
        for (const item of drift.drifted) {
            add('warn', 'declaration-drift', `${item.source} is declared directly; the active publication pins ${item.pinned}.`, 'The next publish rewrites it, but the running Pi already loaded the direct source.');
        }
        if (drift.unmanaged.length) {
            add('warn', 'unmanaged-packages', `Declared in Pi settings but not by the active publication: ${drift.unmanaged.map(item => item.source).join(', ')}.`, `Run: pi-manager adopt --profile ${active.profile ?? '<name>'} --yes, or press A on this report inside /manager.`);
        }
        else if (declarations.length) {
            add('ok', 'declarations', `All ${declarations.length} published declaration${declarations.length === 1 ? ' matches' : 's match'} Pi settings.`);
        }
        if (!declarations.length && published)
            add('ok', 'declarations', 'No package declarations to reconcile.');
    }
    catch (error) {
        add('error', 'agent-settings-unreadable', errorMessage(error), `Check ${join(agentDir, 'settings.json')}`);
    }
    try {
        if (!(await bundleDeclarations(agentDir)).length) {
            add('warn', 'bundle-not-declared', 'The published bundle is not declared in Pi settings, so Pi will not load it.', 'Register it: pi-manager install --yes');
        }
        const stale = await staleBundleDeclarations(agentDir);
        if (stale.length) {
            add('warn', 'stale-bundle-declaration', `Superseded publish directories are still declared: ${stale.join(', ')}.`, `Remove them so resources are not loaded twice: pi remove ${stale.map(item => resolve(agentDir, item)).join(' ')}`);
        }
    }
    catch (error) {
        add('warn', 'bundle-declaration-unknown', `Cannot inspect Pi package declarations: ${errorMessage(error)}`);
    }
    report.ok = !findings.some(finding => finding.level === 'error');
    return report;
}
