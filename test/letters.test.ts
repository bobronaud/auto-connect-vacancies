import { describe, expect, it, vi } from 'vitest';
import { generateLetter, letterProblems } from '../src/letters.js';
import { codexArgs, parseCodexEvents } from '../src/llm/codexCli.js';
import type { Config } from '../src/config.js';
import { order, validLetter } from './fixtures.js';

const config: Config = { browser: { headless: true }, llm: { effort: 'medium', timeoutSec: 180, maxChars: 1200, candidate: 'Разработчик с широким технологическим кругозором' }, apply: { delaySec: 0, dryRun: false } };
describe('Генерация писем', () => {
  it('передаёт полное описание и навыки и возвращает готовое письмо', async () => {
    const run = vi.fn(async (_req: { system: string; prompt: string }) => validLetter);
    expect(await generateLetter(order(), config, undefined, run)).toBe(validLetter);
    expect(run.mock.calls[0]?.[0].prompt).toContain(order().description);
    expect(run.mock.calls[0]?.[0].prompt).toContain(order().skills);
  });
  it('перегенерирует некорректное письмо один раз', async () => {
    const run = vi.fn().mockResolvedValueOnce('Коротко').mockResolvedValueOnce(validLetter);
    expect(await generateLetter(order(), config, undefined, run)).toBe(validLetter);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it.each(['5+ лет опыта', 'более 5 лет опыта', 'пять лет опыта', 'Опыт разработки более 5 лет', '5+ years of experience', 'five years of experience'])('отклоняет стаж «%s» и перегенерирует письмо', async experience => {
    const invalid = `${validLetter} ${experience}.`;
    expect(letterProblems(invalid, 1200)).toContain('запрещено указывать стаж кандидата в годах');
    const run = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValueOnce(validLetter);
    expect(await generateLetter(order(), config, undefined, run)).toBe(validLetter);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('не возвращает письмо при повторном упоминании стажа', async () => {
    const run = vi.fn(async () => `${validLetter} У меня 5+ лет опыта.`);
    await expect(generateLetter(order(), config, undefined, run)).rejects.toThrow('запрещено указывать стаж');
  });
  it('повторяет один раз при временной ошибке Codex', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('Временная ошибка')).mockResolvedValueOnce(validLetter);
    expect(await generateLetter(order(), config, undefined, run)).toBe(validLetter);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('после двух ошибок не возвращает письмо', async () => {
    const run = vi.fn(async () => '# Ошибка');
    await expect(generateLetter(order(), config, undefined, run)).rejects.toThrow('двух попыток');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('отклоняет шаблоны, разметку и длинный текст', () => {
    expect(letterProblems(validLetter, 1200)).toEqual([]);
    expect(letterProblems(validLetter + ' [уточнить]', 1200)).toContain('незаполненный шаблон');
    expect(letterProblems('**Здравствуйте** ' + validLetter, 1200)).toContain('Markdown-разметка');
    expect(letterProblems(validLetter.repeat(10), 1200).join()).toContain('длиннее');
  });
  it.each(['—', '–', ';'])('отклоняет запрещённый символ %s и перегенерирует письмо', async symbol => {
    const invalid = `${validLetter} ${symbol} Обсудим детали.`;
    expect(letterProblems(invalid, 1200).length).toBeGreaterThan(0);
    const run = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValueOnce(validLetter);
    expect(await generateLetter(order(), config, undefined, run)).toBe(validLetter);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('допускает обычный дефис и не возвращает письмо с повторным нарушением пунктуации', async () => {
    expect(letterProblems(`${validLetter} React - подходящий инструмент.`, 1200)).toEqual([]);
    const run = vi.fn(async () => `${validLetter} — Обсудим детали; напишите.`);
    await expect(generateLetter(order(), config, undefined, run)).rejects.toThrow('двух попыток');
  });
  it('собирает изолированный вызов без shell и инструментов', () => {
    const args = codexArgs(config.llm, '/tmp/instructions.txt', 'example-model');
    expect(args).toContain('--ignore-user-config'); expect(args).toContain('--ephemeral');
    expect(args).toContain('read-only'); expect(args).toContain('shell_tool'); expect(args.at(-1)).toBe('-');
  });
  it('читает только итоговый ответ и требует turn.completed', () => {
    const event = (text: string, phase: string) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', phase, text } });
    const stream = [event('Промежуточный текст', 'commentary'), event(validLetter, 'final_answer'), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 30 } })].join('\n');
    expect(parseCodexEvents(stream).text).toBe(validLetter);
    expect(() => parseCodexEvents(event(validLetter, 'final_answer'))).toThrow('не подтвердил');
    expect(() => parseCodexEvents('{bad')).toThrow('JSONL');
    expect(() => parseCodexEvents(JSON.stringify({ type: 'turn.failed', error: { message: 'quota exceeded' } }))).toThrow('quota exceeded');
  });
});
