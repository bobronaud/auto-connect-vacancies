import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pc from 'picocolors';
import { stripVTControlCharacters } from 'node:util';

export function privateDir(path: string): string {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  chmodSync(absolute, 0o700);
  return absolute;
}
export const errorText = (e: unknown): string => e instanceof Error ? e.message : String(e);
/** Website text is untrusted terminal input, including OSC clipboard/hyperlink sequences. */
export function terminalText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/\u001b\][^\u0007]*(?:\u0007|$)/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
export const log = {
  info: (s: string) => console.log(pc.cyan(terminalText(s))),
  success: (s: string) => console.log(pc.green(terminalText(s))),
  warn: (s: string) => console.log(pc.yellow(terminalText(s))),
  error: (s: string) => console.error(pc.red(terminalText(s))),
  debug: (s: string) => { if (process.env.CONNECT_DEBUG === '1') console.log(pc.dim(terminalText(s))); },
};
export function throwIfAborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('Операция отменена')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
