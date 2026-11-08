import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const installed = spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).status === 0;
describe.skipIf(!installed)('Проверка секретов перед коммитом', () => {
  let dir: string;
  const run = (args: string[], env = process.env) => spawnSync(process.execPath, [join(dir, 'scripts/check-secrets.mjs'), ...args], { cwd: dir, encoding: 'utf8', env });
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'connect-secret-guard-'));
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, '.githooks'));
    for (const name of ['check-secrets.mjs', 'install-hooks.mjs']) copyFileSync(resolve('scripts', name), join(dir, 'scripts', name));
    copyFileSync(resolve('.gitleaks.toml'), join(dir, '.gitleaks.toml'));
    copyFileSync(resolve('.githooks/pre-commit'), join(dir, '.githooks/pre-commit'));
    expect(git('init', '-q').status).toBe(0);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  it('пропускает безопасные изменения', () => {
    writeFileSync(join(dir, 'safe.txt'), 'Безопасный текст\n');
    expect(git('add', 'safe.txt').status).toBe(0);
    expect(run(['--staged']).status).toBe(0);
  });
  it('блокирует файлы сессии по имени до сканирования', () => {
    mkdirSync(join(dir, '.data'));
    writeFileSync(join(dir, '.data/session.json'), '{}');
    expect(git('add', '.data/session.json').status).toBe(0);
    const result = run(['--staged']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('конфиденциальные файлы');
  });
  it('блокирует синтетический токен без вывода его значения', () => {
    const token = 'ghp_' + randomBytes(18).toString('hex');
    writeFileSync(join(dir, 'example.js'), `const credential = "${token}";\n`);
    expect(git('add', 'example.js').status).toBe(0);
    const result = run(['--staged']);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(token);
  });
  it('при отсутствии gitleaks запрещает коммит', () => {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const gitPath = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(gitPath, join(bin, 'git'));
    const result = run(['--staged'], { ...process.env, PATH: bin });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('нужен gitleaks');
  });
  it('устанавливает настоящий pre-commit, который блокирует опасный коммит', () => {
    expect(spawnSync(process.execPath, [join(dir, 'scripts/install-hooks.mjs')], { cwd: dir }).status).toBe(0);
    expect(git('config', '--local', '--get', 'core.hooksPath').stdout.trim()).toBe('.githooks');
    mkdirSync(join(dir, '.data')); writeFileSync(join(dir, '.data/session.json'), '{}');
    git('add', '.data/session.json');
    const result = git('-c', 'user.name=Security Test', '-c', 'user.email=security@example.test', 'commit', '-m', 'Synthetic security fixture');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('конфиденциальные файлы');
  });
});
