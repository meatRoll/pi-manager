import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Optional presentation metadata only. Never fetch or inspect a parent repo. */
export async function localPackageOrigin(root: string, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  try {
    const marker = await stat(join(root, '.git'));
    if (!marker.isDirectory() && !marker.isFile()) return undefined;
    signal?.throwIfAborted();
    // Ignore inherited Git overrides; --local/--no-includes reads only this
    // checkout's config. Git itself handles .git files in linked worktrees.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    return await new Promise<string | undefined>(resolve => {
      const child = spawn('git', ['-C', root, 'config', '--local', '--no-includes', '--get', 'remote.origin.url'], {
        env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, signal,
      });
      let output = '', failed = false;
      child.stdout.on('data', chunk => {
        if (failed) return;
        output += chunk;
        if (output.length > 8192) { failed = true; child.kill(); }
      });
      child.on('error', () => { failed = true; });
      // Wait for close even on abort so no background process survives the panel.
      child.on('close', code => {
        const origin = output.trim();
        resolve(!failed && code === 0 && origin && !/[\0\r\n]/.test(origin) ? origin : undefined);
      });
    });
  } catch { return undefined; } // Git missing, unsafe checkout or missing metadata.
  finally { signal?.throwIfAborted(); }
}
