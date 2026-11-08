import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

process.umask(0o077);
const path = process.env.PLAYWRIGHT_BROWSERS_PATH ?? resolve('.data/browsers');
if (path !== '0') mkdirSync(path, { recursive: true, mode: 0o700 });
const result = spawnSync(process.execPath, [resolve('node_modules/playwright/cli.js'), 'install', 'chromium'], {
  stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path },
});
if (result.error) console.error('Не удалось запустить установку Chromium.');
process.exitCode = result.status ?? 1;
