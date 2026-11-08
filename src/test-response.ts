import { select, Separator } from '@inquirer/prompts';
import pc from 'picocolors';
import type { Config } from './config.js';
import type { Store } from './storage.js';
import { generateLetter } from './letters.js';
import { theme, context } from './menu.js';
import { log, terminalText, throwIfAborted } from './utils.js';

export async function testResponse(store: Store, config: Config, signal: AbortSignal): Promise<void> {
  const orders = store.orders();
  if (!orders.length) {
    log.info('Сохранённых заказов пока нет. Сначала выберите «Собрать заказы».');
    return;
  }
  const id = await select<string | null>({
    message: 'Выберите заказ для тестового отклика (без отправки)', theme, pageSize: 12,
    choices: [
      ...orders.map(o => ({ value: o.id, name: `${terminalText(o.title).replace(/\s+/g, ' ')} · ${terminalText(o.id)}` })),
      new Separator(' '), { name: '↩  Назад', value: null },
    ],
  }, { ...context, signal });
  if (id === null) return;
  const order = orders.find(o => o.id === id)!;
  log.info('Генерирую тестовое сопроводительное письмо…');
  const letter = await generateLetter(order, config, signal);
  throwIfAborted(signal);
  console.log(`\n${pc.bold('Название заказа\n')}${terminalText(order.title)}\n${pc.dim(terminalText(order.url))}\n`);
  console.log(pc.bold('Описание\n') + terminalText(order.description));
  console.log('\n' + pc.bold('Требования к навыкам\n') + terminalText(order.skills || 'Не указаны'));
  console.log('\n' + pc.bold('Тестовое сопроводительное письмо\n') + terminalText(letter));
  log.info('\nТест завершён. Письмо никому не отправлено.\n');
}
