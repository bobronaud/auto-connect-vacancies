import type { Config } from './config.js';
import type { Order } from './types.js';
import { isRelevant } from './types.js';
import type { Store } from './storage.js';
import { HttpError } from './connect/http.js';
import { TelegramStop } from './telegram.js';
import { errorText, log, pause, throwIfAborted } from './utils.js';

export type Sender = { prepare(username: string): Promise<void>; send(text: string): Promise<number> };
export type ApplyDependencies = {
  refresh(order: Order): Promise<Order>;
  letter(order: Order): Promise<string>;
  sender: Sender;
};

export async function applyQueue(store: Store, config: Config, deps: ApplyDependencies, signal?: AbortSignal): Promise<void> {
  const queue = store.queue();
  if (!queue.length) { log.info('Очередь пуста. Сначала выберите «Собрать заказы».'); return; }
  let sent = 0, skipped = 0, failed = 0;
  for (let index = 0; index < queue.length; index++) {
    throwIfAborted(signal);
    const old = queue[index]!;
    if (store.blocked(old.id)) continue;
    log.info(`[${index + 1}/${queue.length}] ${old.title}`);
    let o: Order;
    try {
      o = await deps.refresh(old);
      store.upsert(o);
    } catch (e) {
      throwIfAborted(signal);
      if (e instanceof HttpError && [403, 429].includes(e.status)) throw e;
      if (e instanceof HttpError && [404, 410].includes(e.status)) {
        const closed = { ...old, open: false };
        store.upsert(closed);
        store.start(closed, '', 'skipped', 'Заказ удалён или больше недоступен');
        skipped++;
      } else {
        store.start(old, '', 'failed', `Не удалось перепроверить заказ: ${errorText(e)}`);
        failed++;
      }
      log.warn(`  Заказ не отправлен: ${errorText(e)}`);
      continue;
    }
    if (!isRelevant(o) || !o.contact) {
      const reason = !isRelevant(o) ? 'Заказ закрыт или больше не соответствует фильтрам' : o.contactReason ?? 'Нет однозначного контакта';
      store.start(o, '', 'skipped', reason);
      log.warn(`  Пропущен: ${reason}`);
      skipped++;
      continue;
    }
    let text = '';
    try {
      text = await deps.letter(o);
      throwIfAborted(signal);
      if (config.apply.dryRun) {
        store.start(o, text, 'draft', 'Пробный режим: сообщение не отправлялось');
        log.info('  Черновик сохранён. Пробный режим, отправки нет.');
        continue;
      }
      await deps.sender.prepare(o.contact);
    } catch (e) {
      throwIfAborted(signal);
      store.start(o, text, 'failed', errorText(e));
      failed++;
      if (e instanceof TelegramStop) throw e;
      log.warn(`  Ошибка подготовки: ${errorText(e)}`);
      continue;
    }
    throwIfAborted(signal);
    const attempt = store.start(o, text);
    try {
      const mid = await deps.sender.send(text);
      store.finish(attempt, 'sent', 'Отправка подтверждена Telegram', mid);
      log.success(`  Отправлено → @${o.contact}`);
      sent++;
    } catch (e) {
      // From this point a write may have happened, even if the browser timed out.
      store.finish(attempt, 'unconfirmed', errorText(e));
      failed++;
      throwIfAborted(signal);
      if (e instanceof TelegramStop) throw e;
      log.warn(`  Результат не подтверждён: ${errorText(e)}. Автоповтора не будет.`);
    }
    if (index < queue.length - 1) {
      log.info(`  Пауза ${config.apply.delaySec} с…`);
      await pause(config.apply.delaySec * 1000, signal);
    }
  }
  log.success(`Готово. Отправлено: ${sent}, пропущено: ${skipped}, ошибок: ${failed}.`);
}
