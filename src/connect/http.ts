import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class HttpError extends Error {
  constructor(public status: number) { super(`Сайт вернул HTTP ${status}${status === 403 ? ' Forbidden: доступ запрещён' : ''}`); }
}

export function publicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  // Global unicast only; mapped IPv4 and local IPv6 are excluded.
  return isIP(ip) === 6 && /^[23][0-9a-f]{3}:/i.test(ip);
}

async function checkUrl(url: URL): Promise<void> {
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Поддерживаются только публичные HTTPS-ссылки без учётных данных.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) {
    throw new Error('Ссылка ведёт на локальный или служебный адрес.');
  }
}

export type DocumentResponse = { url: string; text: string; contentType: string; location: string | null };
export async function getDocument(
  input: string, signal?: AbortSignal, follow = true,
): Promise<DocumentResponse> {
  let url = new URL(input);
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal?.throwIfAborted();
    await checkUrl(url);
    const timeout = AbortSignal.timeout(30_000);
    const response = await fetch(url, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'manual', headers: { 'User-Agent': 'auto-connect-vacancies/0.1', Accept: 'text/html, application/json' },
    });
    const location = response.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(response.status) && location) {
      await response.body?.cancel();
      const target = new URL(location, url);
      await checkUrl(target);
      if (!follow) return { url: url.href, text: '', contentType: '', location: target.href };
      url = target;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Сайт вернул пустой ответ.');
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 5 * 1024 * 1024) { await reader.cancel(); throw new Error('Страница превышает допустимый размер 5 МБ.'); }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
    return { url: url.href, text: Buffer.concat(parts).toString('utf8'), contentType: response.headers.get('content-type') ?? '', location: null };
  }
  throw new Error('Слишком много перенаправлений.');
}
