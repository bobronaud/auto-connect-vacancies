import { load } from 'cheerio';
import type { Order } from '../types.js';

export const ROLE_LABELS: Record<string, string> = {
  'Frontend Developer': 'Фронтенд-разработка',
  'Fullstack Developer': 'Фулстек-разработка',
  'Chatbot Developer': 'Разработка чат-ботов',
  'Telegram Developer': 'Telegram-разработка',
  'Mobile Developer': 'Мобильная разработка',
};

const clean = (s: string) => s.replace(/[\t \u00a0\u202f]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();

/** Materialize React's streamed HTML slots without evaluating website scripts. */
export function streamedDocument(html: string): ReturnType<typeof load> {
  const $ = load(html);
  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    $('[id^="S:"]').each((_, e) => {
      const chunk = $(e);
      const suffix = chunk.attr('id')!.slice(2);
      const target = $(`[id="P:${suffix}"], [id="B:${suffix}"]`).first();
      if (!target.length) return;
      target.replaceWith(chunk.contents());
      chunk.remove();
      moved = true;
    });
    if (!moved) break;
  }
  return $;
}

export function orderId(url: string): string {
  const u = new URL(url);
  const match = /^\/orders\/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})\/?$/i.exec(u.pathname);
  if (u.origin !== 'https://connect.tg' || !match) throw new Error('Некорректная ссылка заказа Connect.');
  return match[1]!.toLowerCase();
}

/** Parse the actual order article, never the footer or similar-order blocks. */
export function parseOrder(html: string, url: string): Order {
  const id = orderId(url);
  const $ = streamedDocument(html);
  $('script, style, noscript').remove();
  const article = $('main article').filter((_, e) => $(e).find('h1').length > 0).first();
  const root = article.length ? article : $('main').first();
  const title = clean(root.find('h1').first().text());
  const section = (name: string): string => {
    const heading = root.find('h2').filter((_, e) => clean($(e).text()) === name).first();
    if (!heading.length) return '';
    const container = heading.closest('section');
    const body = container.length ? container.clone() : heading.parent().clone();
    body.find('h2, button, script, style').remove();
    body.find('p, br, li').each((_, e) => { $(e).after('\n'); });
    if (name === 'Требования к навыкам') body.find('span').each((_, e) => { $(e).after(' '); });
    return clean(body.text());
  };
  const facts = new Map<string, string>();
  $('main dl dt').each((_, e) => {
    const label = $(e).clone(); label.find('button').remove();
    facts.set(clean(label.text()), clean($(e).siblings('dd').text()));
  });
  const description = section('Описание');
  const platform = facts.get('Площадка') ?? '';
  const state = facts.get('Статус') ?? '';
  const specs = facts.get('Специализации') ?? facts.get('Специализация');
  if (!title || !description || !platform || !state || !specs) {
    throw new Error('Структура карточки изменилась: отсутствуют обязательные поля заказа.');
  }
  const links = $('main a[href]').filter((_, e) => /^(Открыть страницу заказа|Написать заказчику в Telegram|Откликнуться)$/.test(clean($(e).text())));
  let sourceUrl: string | null = null;
  links.each((_, e) => {
    if ($(e).closest('section#similar').length || $(e).closest('article').find('h3').length) return;
    const raw = $(e).attr('href');
    if (!raw) return;
    const target = new URL(raw, url);
    if (target.origin !== 'https://connect.tg' || target.pathname.includes('/contact')) sourceUrl ??= target.href;
  });
  return {
    id, url: `https://connect.tg/orders/${id}`, title, description,
    skills: section('Требования к навыкам'), platform,
    specializations: specs.split(/[,;]/).map(s => s.trim()),
    open: /^Открыт(?:,|$)/i.test(state), budget: facts.get('Стоимость') ?? '',
    // SSR hides the contact button until hydration. The public OrdersBoard exposes
    // this exact GET link for every order; it redirects to the original contact.
    sourceUrl: sourceUrl ?? `https://connect.tg/tma/api/v1/public/orders/${id}/contact`,
    contact: null, contactReason: null, collectedAt: new Date().toISOString(),
  };
}

const RESERVED = new Set(['share', 'joinchat', 'addstickers', 'addemoji', 'proxy', 'socks', 'login', 'iv', 's', 'c', 'boost', 'giftcode', 'invoice', 'contact', 'confirmphone', 'setlanguage']);
export function personalUsername(link: string): string | null {
  let u: URL;
  try { u = new URL(link); } catch { return null; }
  if (!['https:', 'http:'].includes(u.protocol) || !['t.me', 'telegram.me', 'www.t.me', 'www.telegram.me'].includes(u.hostname)) return null;
  const m = /^\/([A-Za-z][A-Za-z\d_]{3,31})\/?$/.exec(u.pathname);
  if (!m || RESERVED.has(m[1]!.toLowerCase()) || /bot$/i.test(m[1]!) || u.searchParams.has('start') || u.searchParams.has('startapp')) return null;
  return m[1]!.toLowerCase();
}

export function textContacts(text: string): string[] {
  const result = new Set<string>();
  for (const match of text.matchAll(/(?<![\w@])@([A-Za-z][A-Za-z\d_]{3,31})\b/g)) {
    const user = personalUsername(`https://t.me/${match[1]}`);
    if (user) result.add(user);
  }
  for (const match of text.matchAll(/https?:\/\/(?:www\.)?(?:t|telegram)\.me\/[^\s<>"')]+/gi)) {
    const user = personalUsername(match[0].replace(/[.,;!?]+$/, ''));
    if (user) result.add(user);
  }
  return [...result];
}

export function chooseContact(candidates: string[]): { contact: string | null; reason: string | null } {
  const users = [...new Set(candidates.map(c => c.toLowerCase()))];
  if (users.length === 1) return { contact: users[0]!, reason: null };
  return { contact: null, reason: users.length ? 'Найдено несколько возможных контактов заказчика' : 'Личный контакт заказчика не найден' };
}

/** Read only the linked post, not channel headers or neighbouring posts. */
export function contactsFromSource(html: string, url: string): string[] {
  const $ = load(html);
  $('script, style, nav, header, footer').remove();
  const u = new URL(url);
  if (['t.me', 'telegram.me'].includes(u.hostname)) {
    const m = /^\/(?:s\/)?([\w]+)\/(\d+)\/?$/.exec(u.pathname);
    if (!m) return [];
    const post = $('[data-post]').filter((_, e) => $(e).attr('data-post')?.toLowerCase() === `${m[1]}/${m[2]}`.toLowerCase()).first();
    if (!post.length) return [];
    const content = post.find('.tgme_widget_message_text');
    return textContacts(content.text() + '\n' + content.find('a[href]').map((_, e) => $(e).attr('href')).get().join('\n'));
  }
  const root = $('main').length ? $('main') : $('body');
  return textContacts(root.text() + '\n' + root.find('a[href]').map((_, e) => $(e).attr('href')).get().join('\n'));
}
