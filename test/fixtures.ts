import type { Order } from '../src/types.js';
export const ID = '11111111-1111-4111-8111-111111111111';
export const ID2 = '22222222-2222-4222-8222-222222222222';
export function order(patch: Partial<Order> = {}): Order {
  return {
    id: ID, url: `https://connect.tg/orders/${ID}`, title: 'Разработать панель React',
    description: 'Нужна панель управления подписками на React и TypeScript. Пишите @test_client.',
    skills: 'React TypeScript', platform: 'Telegram-чат', specializations: ['Фронтенд-разработка'],
    open: true, budget: '50 000 ₽', sourceUrl: 'https://t.me/test_client',
    contact: 'test_client', contactReason: null, collectedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}
export function html(patch: { status?: string; platform?: string; description?: string; skills?: string; extra?: string } = {}): string {
  return `<html><body><main><article>
    <section><h1>Разработать панель React</h1></section>
    <section><h2>Описание</h2><div><p>${patch.description ?? 'Нужна панель React.'}</p><p>Второй абзац.</p></div><button>Читать дальше</button></section>
    ${patch.skills ?? '<section><h2>Требования к навыкам</h2><div><span>React</span><span>TypeScript</span></div></section>'}
  </article><aside><dl>
    <div><dt>Статус</dt><dd>${patch.status ?? 'Открыт, принимает отклики'}</dd></div>
    <div><dt>Площадка</dt><dd>${patch.platform ?? 'Telegram-чат'}</dd></div>
    <div><dt>Специализации</dt><dd>Фронтенд-разработка, Фулстек-разработка</dd></div>
    <div><dt>Стоимость</dt><dd>50 000 ₽</dd></div>
  </dl><a href="https://t.me/test_client">Написать заказчику в Telegram</a></aside>
  <section id="similar"><article><h3>Другой заказ</h3><a href="https://t.me/wrong_client">Откликнуться</a></article></section>
  ${patch.extra ?? ''}</main><footer><a href="https://t.me/site_support">Откликнуться</a></footer></body></html>`;
}
export const validLetter = 'Здравствуйте! Меня заинтересовала задача разработки панели управления подписками на React и TypeScript. Работал с подобными интерфейсами и интеграцией API, могу продумать удобную работу с данными и состояниями. Предлагаю обсудить структуру панели и требования к интеграциям.';
