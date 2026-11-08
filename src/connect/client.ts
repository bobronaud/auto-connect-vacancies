import { z } from 'zod';
import type { Order } from '../types.js';
import { isRelevant } from '../types.js';
import { errorText, log, pause, throwIfAborted } from '../utils.js';
import { getDocument, HttpError } from './http.js';
import { chooseContact, contactsFromSource, orderId, parseOrder, personalUsername, ROLE_LABELS, textContacts } from './parse.js';
import type { Store } from '../storage.js';

const listSchema = z.object({
  orders: z.array(z.object({
    slug: z.string().uuid(), niche: z.string(), roles: z.array(z.string()),
    source: z.string(), isActive: z.boolean(), respondUrl: z.string().nullish(),
  })),
  hasMore: z.boolean(),
});

export class ConnectClient {
  constructor(private signal?: AbortSignal) {}

  async *links(): AsyncGenerator<string> {
    const seen = new Set<string>();
    // These are the same public filters and pagination endpoint used by OrdersBoard.
    for (const role of Object.keys(ROLE_LABELS)) {
      let page = 1;
      const roleSeen = new Set<string>();
      for (;;) {
        throwIfAborted(this.signal);
        const params = new URLSearchParams({ direction: 'development', source: 'telegram', role, page: String(page) });
        const doc = await getDocument(`https://connect.tg/api/orders?${params}`, this.signal);
        let data: z.infer<typeof listSchema>;
        try { data = listSchema.parse(JSON.parse(doc.text)); }
        catch { throw new Error('Изменился формат списка заказов Connect. Сбор остановлен, предыдущие результаты сохранены.'); }
        let fresh = 0;
        for (const item of data.orders) {
          if (!roleSeen.has(item.slug)) { roleSeen.add(item.slug); fresh++; }
          if (seen.has(item.slug)) continue;
          seen.add(item.slug);
          if (item.niche !== 'development' || item.source !== 'Telegram' || !item.isActive || !item.roles.some(r => r in ROLE_LABELS)) continue;
          yield `https://connect.tg/orders/${item.slug}`;
        }
        if (!data.hasMore) break;
        if (!fresh) throw new Error('Пагинация Connect повторяет страницы. Сбор остановлен, результаты сохранены.');
        page++;
        await pause(250, this.signal);
      }
    }
  }

  async order(url: string): Promise<Order> {
    orderId(url);
    const doc = await getDocument(url, this.signal);
    return parseOrder(doc.text, url);
  }

  async resolve(o: Order): Promise<Order> {
    const candidates = textContacts(o.description);
    let link = o.sourceUrl;
    let failure: string | null = null;
    try {
      if (link) {
        const u = new URL(link);
        // Follow the website's public contact link without triggering any response/subscription POST.
        if (u.origin === 'https://connect.tg' && /^\/tma\/api\/v1\/public\/orders\/[a-f\d-]+\/contact$/.test(u.pathname)) {
          const response = await getDocument(link, this.signal, false);
          link = response.location;
          if (!link) failure = 'Публичная ссылка не раскрыла контакт заказчика';
        }
        if (link) {
          const direct = personalUsername(link);
          if (direct) candidates.push(direct);
          else {
            const target = new URL(link);
            if (['t.me', 'telegram.me'].includes(target.hostname)) {
              const post = /^\/(?:s\/)?([A-Za-z\d_]+)\/(\d+)\/?$/.exec(target.pathname);
              if (!post) failure = 'Ссылка ведёт на бота, мини-приложение или неподдерживаемый Telegram-контакт';
              else {
                const source = await getDocument(`https://t.me/s/${post[1]}/${post[2]}`, this.signal);
                candidates.push(...contactsFromSource(source.text, source.url));
              }
            } else if (target.origin === 'https://connect.tg') failure = 'Контакт доступен только через Connect';
            else {
              const source = await getDocument(link, this.signal);
              if (!/text\/html/i.test(source.contentType)) failure = 'Страница заказчика имеет неподдерживаемый формат';
              else candidates.push(...contactsFromSource(source.text, source.url));
            }
          }
        }
      }
    } catch (e) {
      throwIfAborted(this.signal);
      failure = `Не удалось проверить ссылку заказчика: ${errorText(e)}`;
    }
    const chosen = chooseContact(candidates);
    // Unreadable linked sources may hide contradictory recipients; do not guess.
    return { ...o, sourceUrl: link ?? o.sourceUrl, contact: failure ? null : chosen.contact, contactReason: failure ?? chosen.reason };
  }
}

export async function collect(store: Store, client: ConnectClient, signal?: AbortSignal): Promise<void> {
  let saved = 0, unavailable = 0, skipped = 0;
  for await (const url of client.links()) {
    throwIfAborted(signal);
    const id = orderId(url);
    if (store.blocked(id)) { skipped++; continue; }
    try {
      let o = await client.order(url);
      if (isRelevant(o)) o = await client.resolve(o);
      store.upsert(o);
      if (isRelevant(o)) {
        saved++;
        log.info(`  ${saved}. ${o.title}`);
        if (!o.contact) { unavailable++; log.warn(`     ${o.contactReason}`); }
      }
    } catch (e) {
      throwIfAborted(signal);
      if (e instanceof HttpError && [403, 429].includes(e.status)) throw e;
      log.warn(`  Не удалось обработать ${url}: ${errorText(e)}`);
    }
    await pause(250, signal);
  }
  log.success(`Сбор завершён. Подходящих: ${saved}, без однозначного контакта: ${unavailable}, уже обработано: ${skipped}.`);
}
