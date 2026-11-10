import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireLock, Store } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
import { applyQueue } from '../src/apply.js';
import { TelegramStop } from '../src/telegram.js';
import { HttpError } from '../src/connect/http.js';
import { ID2, order, validLetter } from './fixtures.js';

let dir: string;
let store: Store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'connect-test-')); store = new Store(join(dir, 'db.sqlite')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('Хранение', () => {
  it('загружает пустой список по умолчанию и личные исключения из конфига', () => {
    const path = join(dir, 'config.yaml');
    expect(loadConfig(path).collect.excludedKeywords).toEqual([]);
    writeFileSync(path, 'collect:\n  excludedKeywords: [" BlockedBrand ", "другое слово"]\n');
    expect(loadConfig(path).collect.excludedKeywords).toEqual(['BlockedBrand', 'другое слово']);
    writeFileSync(path, 'collect:\n  excludedKeywords: ["   "]\n');
    expect(() => loadConfig(path)).toThrow('collect.excludedKeywords');
  });
  it('скрывает ранее сохранённые заказы BlockedBrand из списка и очереди', () => {
    store.upsert(order({ description: 'Проект BLOCKEDBRAND' }));
    expect(store.orders()).toHaveLength(1);
    expect(store.queue()).toHaveLength(1);
    store.upsert(order({ id: ID2 }));
    expect(store.orders(['blockedbrand']).map(o => o.id)).toEqual([ID2]);
    expect(store.queue(['blockedbrand']).map(o => o.id)).toEqual([ID2]);
    expect(store.queue([])).toHaveLength(2);
  });
  it('навсегда исключает выбранный заказ из списков и повторного сбора, сохраняя историю', () => {
    const o = order(); store.upsert(o);
    store.start(o, '', 'skipped', 'Нет контакта');
    store.upsert(order({ id: ID2 }));
    store.exclude([o.id]);
    store.close(); store = new Store(join(dir, 'db.sqlite'));
    store.upsert({ ...o, title: 'Повторно собранный заказ' });
    expect(store.orders().map(o => o.id)).toEqual([ID2]);
    expect(store.queue().map(o => o.id)).toEqual([ID2]);
    expect(store.blocked(o.id)).toBe(true);
    expect(() => store.start(o, validLetter)).toThrow('исключён');
    expect(store.history()[0]?.snapshot.title).toBe(o.title);
  });
  it('обновляет заказ, сохраняя снимок отправленного отклика', () => {
    const o = order(); store.upsert(o);
    const id = store.start(o, validLetter); store.finish(id, 'sent', 'ok', 123);
    store.upsert({ ...o, title: 'Новое название' });
    expect(store.history()[0]?.snapshot.title).toBe(o.title);
    expect(store.history()[0]?.messageId).toBe(123);
    expect(store.queue()).toHaveLength(0);
    expect(() => store.start(o, validLetter)).toThrow('уже существует');
  });
  it('после сбоя переводит sending в unconfirmed и исключает повтор', () => {
    const o = order(); store.upsert(o); store.start(o, validLetter);
    store.close(); store = new Store(join(dir, 'db.sqlite'));
    expect(store.history()[0]?.status).toBe('unconfirmed');
    expect(store.queue()).toHaveLength(0);
  });
  it('не дублирует собранные заказы и создаёт приватную БД', () => {
    store.upsert(order()); store.upsert(order());
    expect(store.queue()).toHaveLength(1);
    expect(statSync(join(dir, 'db.sqlite')).mode & 0o777).toBe(0o600);
  });
  it('не допускает второй экземпляр и снимает блокировку', () => {
    const path = join(dir, 'lock'); const unlock = acquireLock(path);
    expect(() => acquireLock(path)).toThrow('уже запущено');
    unlock(); acquireLock(path)();
  });
});

describe('Очередь отправки', () => {
  const setup = () => {
    const config = loadConfig(join(dir, 'config.yaml')); config.apply.delaySec = 0;
    const o = order(); store.upsert(o);
    const deps = {
      refresh: vi.fn(async () => o), letter: vi.fn(async () => validLetter),
      sender: { prepare: vi.fn(async () => {}), send: vi.fn(async () => 123) },
    };
    return { config, o, deps };
  };
  it('проверяет актуальность и сохраняет только подтверждённый успех', async () => {
    const { config, deps } = setup();
    await applyQueue(store, config, deps);
    expect(deps.sender.prepare).toHaveBeenCalledWith('test_client');
    expect(store.history()[0]?.status).toBe('sent');
    await applyQueue(store, config, deps);
    expect(deps.sender.send).toHaveBeenCalledTimes(1);
  });
  it('не отправляет закрытые заказы и заказы без контакта', async () => {
    const { config, o, deps } = setup(); deps.refresh.mockResolvedValue({ ...o, open: false });
    await applyQueue(store, config, deps);
    expect(deps.sender.send).not.toHaveBeenCalled(); expect(store.queue()).toHaveLength(0);
  });
  it('не генерирует письмо и не отправляет отклик, если при обновлении появился BlockedBrand', async () => {
    const { config, o, deps } = setup();
    config.collect.excludedKeywords = ['blockedbrand'];
    deps.refresh.mockResolvedValue({ ...o, description: 'Проект BlockedBrand' });
    await applyQueue(store, config, deps);
    expect(deps.letter).not.toHaveBeenCalled();
    expect(deps.sender.prepare).not.toHaveBeenCalled();
    expect(deps.sender.send).not.toHaveBeenCalled();
    expect(store.queue(config.collect.excludedKeywords)).toHaveLength(0);
  });
  it('при ошибке генератора не начинает отправку', async () => {
    const { config, deps } = setup(); deps.letter.mockRejectedValue(new Error('Ошибка Codex'));
    await applyQueue(store, config, deps);
    expect(deps.sender.prepare).not.toHaveBeenCalled(); expect(store.history()[0]?.status).toBe('failed');
  });
  it('при неверном получателе не вызывает send', async () => {
    const { config, deps } = setup(); deps.sender.prepare.mockRejectedValue(new Error('Это канал'));
    await applyQueue(store, config, deps);
    expect(deps.sender.send).not.toHaveBeenCalled(); expect(store.history()[0]?.status).toBe('failed');
  });
  it('не повторяет неопределённую отправку', async () => {
    const { config, deps } = setup(); deps.sender.send.mockRejectedValue(new Error('Timeout'));
    await applyQueue(store, config, deps); await applyQueue(store, config, deps);
    expect(store.history()[0]?.status).toBe('unconfirmed'); expect(deps.sender.send).toHaveBeenCalledTimes(1);
  });
  it('останавливает всю очередь при ограничении Telegram', async () => {
    const { config, deps } = setup(); store.upsert(order({ id: ID2, url: `https://connect.tg/orders/${ID2}` }));
    deps.sender.send.mockRejectedValue(new TelegramStop('Telegram ограничил отправку'));
    await expect(applyQueue(store, config, deps)).rejects.toThrow('ограничил');
    expect(deps.sender.send).toHaveBeenCalledTimes(1); expect(store.queue()).toHaveLength(1);
  });
  it('пробный режим сохраняет черновик без доступа к Telegram', async () => {
    const { config, deps } = setup(); config.apply.dryRun = true;
    await applyQueue(store, config, deps);
    expect(deps.sender.prepare).not.toHaveBeenCalled(); expect(deps.sender.send).not.toHaveBeenCalled();
    expect(store.history()[0]?.status).toBe('draft'); expect(store.queue()).toHaveLength(1);
  });
  it('403 прерывает очередь, 404 исключает удалённый заказ', async () => {
    const { config, deps } = setup(); deps.refresh.mockRejectedValue(new HttpError(403));
    await expect(applyQueue(store, config, deps)).rejects.toThrow('403');
    expect(store.history()).toHaveLength(0);
    deps.refresh.mockRejectedValue(new HttpError(404));
    await applyQueue(store, config, deps); expect(store.queue()).toHaveLength(0);
  });
  it('прерывание после начала отправки оставляет unconfirmed', async () => {
    const { config, deps } = setup(); const controller = new AbortController();
    deps.sender.send.mockImplementation(async () => { controller.abort(); throw new Error('Прервано'); });
    await expect(applyQueue(store, config, deps, controller.signal)).rejects.toThrow();
    expect(store.history()[0]?.status).toBe('unconfirmed'); expect(store.queue()).toHaveLength(0);
  });
});
