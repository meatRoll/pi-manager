import { openManager } from './pi-manager.js';
import { MANAGER_HOME } from './storage.js';
import { errorMessage } from './errors.js';
/** Pi extension entry point. Registration has no filesystem/process side effects. */
export default function managerExtension(pi, loaded) {
    let open = false;
    pi.registerCommand('manager', {
        description: 'Manage packages, skills, extensions, prompts, themes and context inside Pi',
        handler: async (_args, ctx) => {
            if (!ctx.hasUI || (ctx.mode !== 'tui' && ctx.mode !== 'rpc')) {
                ctx.ui.notify('/manager requires Pi interactive UI (or an RPC client with dialogs).', 'warning');
                return;
            }
            if (!ctx.isIdle()) {
                ctx.ui.notify('Wait for the current agent run to finish before opening /manager.', 'warning');
                return;
            }
            if (open) {
                ctx.ui.notify('/manager is already open.', 'warning');
                return;
            }
            if (loaded && loaded.managerHome !== MANAGER_HOME) {
                ctx.ui.notify('PI_MANAGER_HOME differs from the registered package. Reinstall the manager bundle for this home.', 'error');
                return;
            }
            open = true;
            try {
                await openManager(ctx, loaded);
            }
            catch (error) {
                ctx.ui.notify(errorMessage(error), 'error');
            }
            finally {
                open = false;
                ctx.ui.setStatus('pi-manager-operation', undefined);
            }
        },
    });
    pi.on('session_start', (_event, ctx) => {
        if (ctx.hasUI)
            ctx.ui.setStatus('pi-manager', `manager:${loaded?.profile || 'none'} · /manager`);
    });
    pi.on('before_agent_start', event => {
        if (!loaded?.contexts.length)
            return;
        // One dedicated public prompt section, not a replacement of Pi's prompt or
        // another extension's sections. Bound at startup with the package snapshot.
        event.systemPromptOptions.sections.pi_manager_context = loaded.contexts
            .map(context => `# ${context.name}\n\n${context.content}`).join('\n\n');
    });
}
