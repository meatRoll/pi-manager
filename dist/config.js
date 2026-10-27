import { join, resolve } from 'node:path';
import { canonicalLocation, MANAGER_HOME, PROFILES_DIR, PUBLISH_DIR, PUBLISH_DIR_SOURCE, getState, setPublishDir } from './storage.js';
import { bundleDeclarations, staleBundleDeclarations } from './install-pi.js';
import { publishLocationAvailable } from './bundle.js';
import { sourcePiAgentDir } from './migration.js';
const LABELS = {
    env: 'from PI_MANAGER_PUBLISH_DIR',
    state: 'saved',
    default: 'default',
};
/** Effective layout plus the two ways it can silently disagree with Pi: a stored
 * publish directory that no longer exists, and package declarations Pi would load
 * from somewhere else.
 */
export async function configReport() {
    const lines = [
        `manager home:  ${MANAGER_HOME}`,
        `profiles:      ${PROFILES_DIR}`,
        `publish dir:   ${PUBLISH_DIR} (${LABELS[PUBLISH_DIR_SOURCE]})`,
    ];
    if (PUBLISH_DIR_SOURCE !== 'default' && !publishLocationAvailable()) {
        lines.push(`Unavailable: ${PUBLISH_DIR} is missing and publishing will refuse until its volume returns.`);
    }
    const agentDir = sourcePiAgentDir();
    const registered = await bundleDeclarations(agentDir);
    const publish = canonicalLocation(PUBLISH_DIR);
    if (!registered.some(source => canonicalLocation(resolve(agentDir, source)) === publish)) {
        lines.push(`Pi does not load ${publish} yet: run "pi-manager install --yes".`);
    }
    for (const source of await staleBundleDeclarations(agentDir)) {
        lines.push(`Superseded declaration: pi remove ${canonicalLocation(resolve(agentDir, source))}`);
    }
    const state = await getState();
    if (state.defaultProfile)
        lines.push(`default profile: ${state.defaultProfile}`);
    return lines.join('\n');
}
/** Save or clear the persisted publish directory, then report what Pi must do. */
export async function changePublishDir(value) {
    const saved = await setPublishDir(value);
    const effective = saved || join(MANAGER_HOME, 'pi-package');
    const registered = await bundleDeclarations();
    const agentDir = sourcePiAgentDir();
    const loaded = registered.some(source => canonicalLocation(resolve(agentDir, source)) === canonicalLocation(effective));
    return [
        saved ? `Saved publish directory: ${saved}` : `Cleared the saved publish directory; back to ${effective}`,
        loaded ? 'Pi already loads this directory.' : 'Run "pi-manager install --yes" to publish there and register it, then remove the declaration it reports as superseded.',
    ].join('\n');
}
