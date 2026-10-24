#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { publishBundle, publishedBundle, BUNDLE_DIR } from './bundle.js';
import { run } from './core.js';
import { ensureManagerHome } from './storage.js';
import { errorMessage } from './errors.js';

export async function installPiExtension(acknowledged = false): Promise<void> {
  if (!acknowledged) throw new Error('Pass --yes to register pi-manager in the current Pi agent settings. No other resources, credentials or sessions are copied.');
  await ensureManagerHome();
  // Refresh the implementation path without dropping the chosen preset.
  await publishBundle((await publishedBundle())?.profile || null);
  const code = await run(process.env.PI_MANAGER_PI || 'pi', ['install', BUNDLE_DIR]);
  if (code !== 0) throw new Error(`pi install exited ${code}`);
  console.log(`Installed Pi extension package: ${BUNDLE_DIR}\nRestart Pi, then type /manager. No separate pi-manager process is needed.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installPiExtension(process.argv.includes('--yes')).catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
}
