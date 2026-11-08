import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { select } from '@inquirer/prompts';
import { Store } from '../src/storage.js';
import { loadConfig } from '../src/config.js';
import { generateLetter } from '../src/letters.js';
import { testResponse } from '../src/test-response.js';
import { terminalText } from '../src/utils.js';
import { ID2, order, validLetter } from './fixtures.js';

vi.mock('@inquirer/prompts', () => ({ select: vi.fn(), Separator: class {} }));
vi.mock('../src/letters.js', () => ({ generateLetter: vi.fn() }));

let dir: string;
let store: Store;
const signal = new AbortController().signal;
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'connect-preview-'));
  store = new Store(join(dir, 'db.sqlite'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(generateLetter).mockResolvedValue(validLetter);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
const output = () => terminalText(vi.mocked(console.log).mock.calls.flat().join('\n'));
const config = () => loadConfig(join(dir, 'config.yaml'));

describe('Тестовый отклик', () => {
  it('генерирует только выбранный заказ при выключенном dryRun и не меняет очередь и историю', async () => {
    const first = order();
    const selected = order({ id: ID2, title: 'Второй заказ', contact: null });
    store.upsert(first); store.upsert(selected);
    const before = store.queue();
    const settings = config(); settings.apply.dryRun = false;
    vi.mocked(select).mockResolvedValue(ID2);
    await testResponse(store, settings, signal);
    expect(generateLetter).toHaveBeenCalledExactlyOnceWith(selected, settings, signal);
    for (const text of [selected.title, selected.description, selected.skills, validLetter, 'никому не отправлено']) {
      expect(output()).toContain(text);
    }
    expect(store.queue()).toEqual(before);
    expect(store.history()).toEqual([]);
  });
  it('предлагает и позволяет тестировать уже отправленный закрытый заказ', async () => {
    const selected = order({ open: false }); store.upsert(selected);
    const id = store.start(selected, validLetter); store.finish(id, 'sent', 'ok', 123);
    const before = store.history();
    vi.mocked(select).mockResolvedValue(selected.id);
    await testResponse(store, config(), signal);
    expect(select).toHaveBeenCalledWith(expect.objectContaining({
      choices: expect.arrayContaining([expect.objectContaining({ value: selected.id })]),
    }), expect.objectContaining({ signal }));
    expect(generateLetter).toHaveBeenCalledTimes(1);
    expect(store.history()).toEqual(before);
    expect(store.queue()).toEqual([]);
  });
  it('объясняет, что сначала нужно собрать заказы', async () => {
    await testResponse(store, config(), signal);
    expect(select).not.toHaveBeenCalled();
    expect(generateLetter).not.toHaveBeenCalled();
    expect(output()).toContain('Собрать заказы');
  });
  it('возвращается без генерации при выборе «Назад»', async () => {
    store.upsert(order()); vi.mocked(select).mockResolvedValue(null);
    await testResponse(store, config(), signal);
    expect(generateLetter).not.toHaveBeenCalled();
  });
  it('очищает вывод и указывает отсутствие требований', async () => {
    const selected = order({ title: '\x1b[2JНазвание', description: '\x1b[2JОписание', skills: '' });
    store.upsert(selected); vi.mocked(select).mockResolvedValue(selected.id);
    vi.mocked(generateLetter).mockResolvedValue('\x1b[2J' + validLetter);
    await testResponse(store, config(), signal);
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain('\x1b[2J');
    expect(output()).toContain('Не указаны');
  });
  it('при ошибке генератора не записывает попытку и не сообщает об успехе', async () => {
    store.upsert(order()); vi.mocked(select).mockResolvedValue(order().id);
    vi.mocked(generateLetter).mockRejectedValue(new Error('Ошибка Codex'));
    await expect(testResponse(store, config(), signal)).rejects.toThrow('Ошибка Codex');
    expect(store.history()).toEqual([]);
    expect(output()).not.toContain('Тест завершён');
  });
});
