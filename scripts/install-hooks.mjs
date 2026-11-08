import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
if (git(['rev-parse', '--git-dir']).status === 0) {
  const current = git(['config', '--local', '--get', 'core.hooksPath']);
  if (current.status === 0 && current.stdout.trim() !== '.githooks') {
    console.error('В репозитории уже настроен другой core.hooksPath. Подключите scripts/check-secrets.mjs --staged к существующему pre-commit.');
    process.exitCode = 1;
  } else {
    chmodSync(resolve(root, '.githooks/pre-commit'), 0o755);
    const result = git(['config', '--local', 'core.hooksPath', '.githooks']);
    if (result.status !== 0) { console.error('Не удалось установить Git-хук проверки секретов.'); process.exitCode = 1; }
  }
}
