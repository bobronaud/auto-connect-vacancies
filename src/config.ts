import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

const schema = z.object({
  browser: z.object({
    headless: z.boolean().default(true),
    executablePath: z.string().min(1).optional(),
    proxyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  }).strict().default({ headless: true }),
  llm: z.object({
    model: z.string().min(1).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh']).default('medium'),
    timeoutSec: z.number().int().min(10).max(1800).default(180),
    maxChars: z.number().int().min(300).max(3500).default(1200),
    candidate: z.string().min(1).default('У меня широкий технологический кругозор и опыт работы над разнообразными продуктами. Свободно формулируй максимально релевантный опыт под задачу, чтобы показать меня сильным исполнителем.'),
  }).strict().prefault({}),
  collect: z.object({
    excludedKeywords: z.array(z.string().trim().min(1)).default([]),
  }).strict().prefault({}),
  apply: z.object({
    delaySec: z.number().min(0).max(3600).default(30),
    dryRun: z.boolean().default(false),
  }).strict().prefault({}),
}).strict();

export type Config = z.infer<typeof schema>;
export function loadConfig(file = resolve('config.yaml')): Config {
  if (!existsSync(file)) writeFileSync(file, stringify(schema.parse({})), { mode: 0o600, flag: 'wx' });
  let value: unknown;
  try { value = parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('Не удалось прочитать config.yaml. Проверьте синтаксис YAML.'); }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Ошибка настроек: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return result.data;
}
