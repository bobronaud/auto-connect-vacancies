import { describe, expect, it, vi, beforeEach } from 'vitest';
import { chooseContact, contactsFromSource, parseOrder, personalUsername, textContacts } from '../src/connect/parse.js';
import { isRelevant } from '../src/types.js';
import { publicAddress } from '../src/connect/http.js';
import { html, ID, ID2, order } from './fixtures.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/storage.js';

describe('Карточки и контакты', () => {
  it('читает полное описание и разделяет навыки, исключая похожие заказы', () => {
    const o = parseOrder(html(), order().url);
    expect(o.title).toBe('Разработать панель React');
    expect(o.description).toBe('Нужна панель React.\nВторой абзац.');
    expect(o.skills).toBe('React TypeScript');
    expect(o.specializations).toHaveLength(2);
    expect(o.sourceUrl).toBe('https://t.me/test_client');
    expect(isRelevant(o)).toBe(true);
  });
  it('отсутствие навыков допустимо, отсутствие метаданных - ошибка', () => {
    expect(parseOrder(html({ skills: '' }), order().url).skills).toBe('');
    expect(() => parseOrder('<main><h1>Заказ</h1></main>', order().url)).toThrow('Структура');
  });
  it('собирает отложенные фрагменты React перед чтением метаданных', () => {
    const source = '<template id="B:0"></template><div hidden id="S:0"><main><article><h1>Панель React</h1><section><h2>Описание</h2><p>Полное описание</p></section></article><aside><template id="P:1"></template></aside></main></div>' +
      '<div hidden id="S:1"><dl><div><dt>Статус</dt><dd>Открыт, принимает отклики</dd></div><div><dt>Площадка</dt><dd>Telegram-чат</dd></div><div><dt>Специализация</dt><dd>Фронтенд-разработка</dd></div></dl></div>';
    const o = parseOrder(source, order().url);
    expect(o.open).toBe(true); expect(o.platform).toBe('Telegram-чат');
    expect(o.sourceUrl).toBe(`https://connect.tg/tma/api/v1/public/orders/${ID}/contact`);
  });
  it('закрытые и Kwork не подходят', () => {
    expect(isRelevant(parseOrder(html({ status: 'Закрыт' }), order().url))).toBe(false);
    expect(isRelevant(parseOrder(html({ platform: 'Kwork' }), order().url))).toBe(false);
    expect(isRelevant(order({ specializations: ['Бэкенд-разработка'] }))).toBe(false);
  });
  it.each([
    { title: 'Проект BlockedBrand' },
    { description: 'Разработка для BLOCKEDBRAND.' },
    { skills: 'React blockedbrand' },
    { sourceUrl: 'https://t.me/blockedbrand_team' },
    { contact: 'BlockedBrand_client' },
  ])('исключает BlockedBrand независимо от регистра и поля: %j', patch => {
    expect(isRelevant(order(patch), ['blockedbrand'])).toBe(false);
  });
  it('использует только переданные слова и ищет буквальное совпадение', () => {
    const o = order({ title: 'Проект BlockedBrand' });
    expect(isRelevant(o)).toBe(true);
    expect(isRelevant(o, [])).toBe(true);
    expect(isRelevant(o, ['другое слово', '  BLOCKEDBRAND  '])).toBe(false);
    expect(isRelevant(o, ['.*', '   '])).toBe(true);
  });
  it.each(['https://t.me/s/channel/123', 'https://t.me/channel/123', 'https://t.me/example_bot',
    'https://t.me/example/app?startapp=abc', 'https://t.me/example?start=abc', 'https://t.me/+secret',
    'https://t.me/share?url=x', 'https://t.me/boost/channel', 'https://t.me.evil.test/test_client'])('не принимает %s за личный контакт', link => {
    expect(personalUsername(link)).toBeNull();
  });
  it('извлекает и объединяет username, исключая email', () => {
    expect(textContacts('user@example.com @Test_Client https://t.me/test_client')).toEqual(['test_client']);
    expect(chooseContact(['Test_Client', 'test_client']).contact).toBe('test_client');
    expect(chooseContact(['test_client', 'other_client']).contact).toBeNull();
    expect(chooseContact([]).reason).toContain('не найден');
  });
  it('читает контакт только из исходного поста', () => {
    const source = '<header>@bad_header</header><div data-post="channel/12"><div class="tgme_widget_message_text">@test_client</div></div><div data-post="channel/13"><div class="tgme_widget_message_text">@bad_neighbour</div></div>';
    expect(contactsFromSource(source, 'https://t.me/s/channel/12')).toEqual(['test_client']);
    expect(contactsFromSource(source, 'https://t.me/s/channel/14')).toEqual([]);
  });
  it('отклоняет локальные и служебные IP', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '172.31.1.1', '::1', 'fc00::1', '::ffff:127.0.0.1']) expect(publicAddress(ip)).toBe(false);
    expect(publicAddress('8.8.8.8')).toBe(true);
    expect(publicAddress('2606:4700:4700::1111')).toBe(true);
  });
});

// Stub only the transport: exercise real pagination/filter/contact logic.
vi.mock('../src/connect/http.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/connect/http.js')>();
  return { ...actual, getDocument: vi.fn() };
});
import { getDocument, HttpError } from '../src/connect/http.js';
import { collect, ConnectClient } from '../src/connect/client.js';
const get = vi.mocked(getDocument);
const response = (text: string, location: string | null = null) => ({ text, location, url: 'https://connect.tg/', contentType: 'text/html' });

describe('Сбор из Connect', () => {
  beforeEach(() => { get.mockReset(); });
  it('не сохраняет запрещённые заказы и не ищет их контакты', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connect-filter-'));
    const store = new Store(join(dir, 'db.sqlite'));
    const client = new ConnectClient();
    vi.spyOn(client, 'links').mockImplementation(async function* () {
      yield order().url;
      yield order({ id: ID2, url: `https://connect.tg/orders/${ID2}` }).url;
    });
    vi.spyOn(client, 'order').mockResolvedValueOnce(order({ description: 'Проект BlockedBrand' }))
      .mockResolvedValueOnce(order({ id: ID2, url: `https://connect.tg/orders/${ID2}` }));
    const resolve = vi.spyOn(client, 'resolve').mockImplementation(async o => o);
    try {
      await collect(store, client, undefined, ['blockedbrand']);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(store.orders().map(o => o.id)).toEqual([ID2]);
      expect(store.queue().map(o => o.id)).toEqual([ID2]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('не сохраняет заказ, если BlockedBrand обнаружен в раскрытой ссылке', async () => {
    const client = new ConnectClient();
    vi.spyOn(client, 'links').mockImplementation(async function* () { yield order().url; });
    vi.spyOn(client, 'order').mockResolvedValue(order());
    vi.spyOn(client, 'resolve').mockResolvedValue(order({ sourceUrl: 'https://t.me/blockedbrand_team' }));
    const dir = mkdtempSync(join(tmpdir(), 'connect-filter-'));
    const store = new Store(join(dir, 'db.sqlite'));
    const upsert = vi.spyOn(store, 'upsert');
    try {
      await collect(store, client, undefined, ['blockedbrand']);
      expect(upsert).not.toHaveBeenCalled();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('обходит все страницы пяти специализаций и убирает дубли', async () => {
    const calls: URL[] = [];
    get.mockImplementation(async input => {
      const u = new URL(input); calls.push(u);
      const role = u.searchParams.get('role')!;
      const page = Number(u.searchParams.get('page'));
      const firstRole = role === 'Frontend Developer';
      const items = page === 2 ? [ID2] : [ID];
      return response(JSON.stringify({ orders: items.map(slug => ({ slug, niche: 'development', roles: [role], source: 'Telegram', isActive: true })), hasMore: firstRole && page === 1 }));
    });
    const urls: string[] = [];
    for await (const url of new ConnectClient().links()) urls.push(url);
    expect(urls).toEqual([`https://connect.tg/orders/${ID}`, `https://connect.tg/orders/${ID2}`]);
    expect(calls).toHaveLength(6);
    expect(calls.every(u => u.searchParams.get('source') === 'telegram' && u.searchParams.get('direction') === 'development')).toBe(true);
    expect(new Set(calls.map(u => u.searchParams.get('role'))).size).toBe(5);
  });
  it('останавливает бесконечную пагинацию', async () => {
    get.mockResolvedValue(response(JSON.stringify({ orders: [{ slug: ID, niche: 'development', roles: ['Frontend Developer'], source: 'Telegram', isActive: true }], hasMore: true })));
    await expect(async () => { for await (const _ of new ConnectClient().links()) { /* exhaust */ } }).rejects.toThrow('повторяет');
  });
  it('не считает 403 пустой выдачей', async () => {
    get.mockRejectedValue(new HttpError(403));
    await expect(async () => { for await (const _ of new ConnectClient().links()) { /* exhaust */ } }).rejects.toThrow('403');
  });
  it('открывает публичную ссылку и сверяет контакт с описанием', async () => {
    get.mockResolvedValue(response('', 'https://t.me/test_client'));
    const client = new ConnectClient();
    const o = order({ sourceUrl: `https://connect.tg/tma/api/v1/public/orders/${ID}/contact` });
    expect((await client.resolve(o)).contact).toBe('test_client');
    get.mockResolvedValue(response('', 'https://t.me/other_client'));
    expect((await client.resolve(o)).contact).toBeNull();
  });
  it('не угадывает контакт при недоступной ссылке или боте', async () => {
    const client = new ConnectClient();
    expect((await client.resolve(order({ sourceUrl: 'https://t.me/example_bot' }))).contact).toBeNull();
    get.mockRejectedValue(new Error('Сеть недоступна'));
    expect((await client.resolve(order({ sourceUrl: 'https://example.test/contact' }))).contact).toBeNull();
  });
});
