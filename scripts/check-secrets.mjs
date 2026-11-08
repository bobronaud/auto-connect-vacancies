import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staged = process.argv.includes('--staged');
// Inspect names before invoking a scanner: session files must never enter Git.
const files = spawnSync('git', staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
if (files.status !== 0) { console.error('Не удалось проверить список файлов Git.'); process.exit(1); }
const forbidden = files.stdout.split('\0').filter(Boolean).filter(name =>
  /(^|\/)(?:\.data|secrets|\.ssh|\.aws)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$|(^|\/)id_(?:rsa|ed25519|ecdsa)(?:\.|$)|(^|\/)config\.yaml$|(^|\/)settings\.local\.json$/i.test(name));
if (forbidden.length) {
  console.error(`Обнаружены конфиденциальные файлы в Git (${forbidden.length}). Уберите их из индекса перед коммитом.`);
  process.exit(1);
}
const result = spawnSync('gitleaks', ['git', ...(staged ? ['--pre-commit', '--staged'] : []),
  '--redact', '--no-banner', '--ignore-gitleaks-allow', '--config', resolve(root, '.gitleaks.toml'), '.'], { cwd: root, stdio: 'inherit' });
if (result.error?.code === 'ENOENT') console.error('Для проверки секретов нужен gitleaks. Установите его и повторите коммит.');
process.exit(result.status ?? 1);
