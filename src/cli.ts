#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { select, Separator } from '@inquirer/prompts';
import pc from 'picocolors';
import { loadConfig } from './config.js';
import { acquireLock, Store } from './storage.js';
import { errorText, log, privateDir, terminalText } from './utils.js';
import { ConnectClient, collect } from './connect/client.js';
import { Telegram } from './telegram.js';
import { applyQueue } from './apply.js';
import { generateLetter } from './letters.js';
import type { AttemptStatus } from './types.js';

const theme = {
  prefix: '', icon: { cursor: pc.cyan('❯') },
  style: { message: () => '', highlight: (text: string) => pc.bold(text),
    keysHelpTip: () => pc.dim('↑↓ перемещение • Enter выбрать • Ctrl+C выход'),
  },
};
const context = { clearPromptOnDone: true };
const labels: Record<AttemptStatus, string> = {
  sending: 'Отправляется', sent: 'Отправлен', failed: 'Ошибка',
  unconfirmed: 'Не подтверждён', skipped: 'Пропущен', draft: 'Черновик',
};
const promptExit = (e: unknown) => e instanceof Error && ['ExitPromptError', 'AbortPromptError'].includes(e.name);

async function history(store: Store, signal: AbortSignal): Promise<void> {
  const kind = await select({ message: '', theme, choices: [
    { name: '✓  Отправленные отклики', value: 'sent' },
    { name: '⚠  Ошибки, пропуски и черновики', value: 'other' },
    { name: '↩  Назад', value: 'back' },
  ] }, { ...context, signal });
  if (kind === 'back') return;
  for (;;) {
    const items = store.history().filter(a => kind === 'sent' ? a.status === 'sent' : a.status !== 'sent');
    if (!items.length) { log.info('Здесь пока нет откликов.'); return; }
    const id = await select<number>({ message: '', theme, pageSize: 12, choices: [
      ...items.map(a => ({ value: a.id, name: `${labels[a.status]} · ${new Date(a.createdAt).toLocaleString('ru-RU')} · ${terminalText(a.snapshot.title).replace(/\s+/g, ' ')}` })),
      new Separator(' '), { name: '↩  Назад', value: -1 },
    ] }, { ...context, signal });
    if (id === -1) return;
    const a = items.find(a => a.id === id)!;
    console.log(`\n${pc.bold(pc.cyan(terminalText(a.snapshot.title)))}\n${pc.dim(terminalText(a.snapshot.url))}\n`);
    console.log(pc.bold('Описание\n') + terminalText(a.snapshot.description));
    console.log('\n' + pc.bold('Требования к навыкам\n') + terminalText(a.snapshot.skills || 'Не указаны'));
    console.log('\n' + pc.bold(a.status === 'sent' ? 'Отправленное письмо\n' : 'Письмо\n') + terminalText(a.letter || 'Не сформировано'));
    console.log(`\n${labels[a.status]} · ${a.recipient ? '@' + terminalText(a.recipient) : 'Получатель не определён'} · ${new Date(a.createdAt).toLocaleString('ru-RU')}`);
    if (a.messageId) console.log(`Telegram ID сообщения: ${a.messageId}`);
    if (a.detail) console.log(pc.dim(terminalText(a.detail)));
    console.log();
  }
}

async function main(): Promise<void> {
  process.umask(0o077);
  privateDir('.data');
  const unlock = acquireLock();
  let store: Store | undefined;
  let active: AbortController | undefined;
  let telegram: Telegram | undefined;
  let stopping = false;
  const lifetime = new AbortController();
  const stop = () => {
    stopping = true;
    lifetime.abort();
    active?.abort(new Error('Операция прервана пользователем'));
    void telegram?.close();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    store = new Store();
    while (!stopping) {
      const config = loadConfig();
      const queue = store.queue();
      const sent = store.history().filter(a => a.status === 'sent').length;
      console.log(`\n${pc.bold(pc.cyan('  CONNECT'))} ${pc.dim('• заказы и отклики')}\n`);
      console.log(pc.dim(`  В очереди: ${queue.length} · С контактом: ${queue.filter(o => o.contact).length} · Отправлено: ${sent} · ${existsSync('.data/telegram-profile') ? 'профиль Telegram сохранён' : 'вход в Telegram не выполнен'}`));
      if (config.apply.dryRun) log.warn('  Пробный режим: письма сохраняются без отправки.');
      console.log();
      const key = await select({ message: '', theme, pageSize: 8, choices: [
        { value: 'collect', name: pc.green('📥  Собрать заказы') },
        { value: 'apply', name: pc.yellow(`🚀  Откликнуться на заказы${queue.length ? ` (${queue.length})` : ''}`) },
        { value: 'history', name: pc.blue('📂  Посмотреть свои отклики') },
        { value: 'login', name: pc.cyan('🔑  Авторизоваться в Telegram') },
        new Separator(pc.dim('  ────────────────────────────────')),
        { value: 'exit', name: pc.red('🚪  Выйти') },
      ] }, { ...context, signal: lifetime.signal }).catch(e => { if (promptExit(e)) return 'exit'; throw e; });
      if (key === 'exit' || stopping) break;
      active = new AbortController();
      try {
        if (key === 'history') await history(store, lifetime.signal);
        else if (key === 'collect') {
          log.info('Собираю открытые заказы Telegram по пяти специализациям…');
          await collect(store, new ConnectClient(active.signal), active.signal);
        } else {
          telegram = new Telegram(config, active.signal);
          if (key === 'login') await telegram.login();
          else {
            const client = new ConnectClient(active.signal);
            const signal = active.signal;
            await applyQueue(store, config, {
              refresh: async o => {
                const current = await client.order(o.url);
                return current.open ? client.resolve(current) : current;
              },
              letter: o => generateLetter(o, config, signal),
              sender: telegram,
            }, signal);
          }
        }
      } catch (e) {
        if (promptExit(e)) { stopping = true; }
        else if (active.signal.aborted) log.warn('Операция прервана. Результаты сохранены.');
        else log.error(errorText(e));
      } finally {
        await telegram?.close(); telegram = undefined; active = undefined;
      }
    }
  } finally {
    await telegram?.close();
    store?.close(); unlock();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

main().catch(e => { log.error(errorText(e)); process.exitCode = 1; });
