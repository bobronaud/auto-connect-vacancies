import { describe, expect, it, vi } from 'vitest';
import { terminalText, log } from '../src/utils.js';
import { parseOrder } from '../src/connect/parse.js';
import { html, order } from './fixtures.js';

describe('Недоверенные данные в терминале', () => {
  it.each([
    '\x1b]52;c;VEVTVA==\x07',
    '\x1b]52;c;VEVTVA==\x1b\\',
    '\x1b[2J\x1b[H',
    '\x1b]0;Поддельный заголовок\x07',
    '\x1b]8;;https://example.test\x1b\\Ссылка\x1b]8;;\x1b\\',
    '\x1b]52;c;unterminated',
    '\x9b2J\x07\x08\r',
  ])('удаляет ANSI/OSC и управляющие символы: %j', payload => {
    expect(terminalText(`Текст ${payload} конец`)).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });
  it('сохраняет русский текст, табуляцию и переносы строк', () => {
    expect(terminalText('Описание\n\tReact и TypeScript')).toBe('Описание\n\tReact и TypeScript');
  });
  it('очищает последовательности из реального пути разбора карточки перед логированием', () => {
    const payload = '\x1b]52;c;VEVTVA==\x07';
    const parsed = parseOrder(html({ description: `Описание ${payload}` }), order().url);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      log.info(parsed.description);
      expect(output.mock.calls[0]![0]).not.toContain(payload);
      expect(terminalText(output.mock.calls[0]![0])).not.toContain('VEVTVA==');
    } finally { output.mockRestore(); }
  });
});
