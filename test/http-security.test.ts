import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ lookup: vi.fn(), fetch: vi.fn(), agent: vi.fn(), proxy: vi.fn(), destroy: vi.fn(async () => {}) }));
vi.mock('node:dns/promises', () => ({ lookup: mock.lookup }));
vi.mock('undici', () => ({
  fetch: mock.fetch,
  Agent: class { constructor(options: unknown) { mock.agent(options); } destroy = mock.destroy; },
  ProxyAgent: class { constructor(options: unknown) { mock.proxy(options); } destroy = mock.destroy; },
}));
import { getDocument, proxyFor } from '../src/connect/http.js';

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'no_proxy', 'NO_PROXY']) vi.stubEnv(key, '');
  mock.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  mock.fetch.mockResolvedValue(new Response('ok', { headers: { 'content-type': 'text/html' } }));
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('Защищённый HTTP-транспорт', () => {
  it('соединяется с проверенным IP, сохраняя Host, SNI и проверку сертификата', async () => {
    const response = await getDocument('https://customer.example/job?x=1');
    expect(mock.lookup).toHaveBeenCalledTimes(1);
    const [url, options] = mock.fetch.mock.calls[0]!;
    expect(url.href).toBe('https://8.8.8.8/job?x=1');
    expect(options.headers.Host).toBe('customer.example');
    expect(options.dispatcher).toBeDefined();
    const tls = mock.agent.mock.calls[0]![0].connect;
    expect(tls.servername).toBe('customer.example');
    expect(tls.rejectUnauthorized).toBe(true);
    expect(tls.checkServerIdentity('8.8.8.8', { subjectaltname: 'DNS:other.example', subject: { CN: 'other.example' } })).toBeInstanceOf(Error);
    expect(response.url).toBe('https://customer.example/job?x=1');
    expect(mock.destroy).toHaveBeenCalledTimes(1);
  });
  it('прокси также получает IP для произвольного домена заказчика', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:8888');
    await getDocument('https://customer.example/job');
    expect(mock.fetch.mock.calls[0]![0].hostname).toBe('8.8.8.8');
    expect(mock.proxy.mock.calls[0]![0].requestTls.servername).toBe('customer.example');
    expect(mock.proxy.mock.calls[0]![0].requestTls.rejectUnauthorized).toBe(true);
  });
  it('разрешает прокси DNS только для фиксированных доменов провайдеров', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:8888');
    await getDocument('https://connect.tg/orders/development');
    expect(mock.fetch.mock.calls[0]![0].hostname).toBe('connect.tg');
    mock.fetch.mockResolvedValue(new Response('ok'));
    await getDocument('https://connect.tg.attacker.example/order');
    expect(mock.fetch.mock.calls[1]![0].hostname).toBe('8.8.8.8');
  });
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fc00::1', '2002:7f00:1::1'])('не отправляет запрос на %s', async ip => {
    const host = ip.includes(':') ? `[${ip}]` : ip;
    await expect(getDocument(`https://${host}/`)).rejects.toThrow('локальный');
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  it('отклоняет имя со смешанным набором публичных и приватных адресов', async () => {
    mock.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(getDocument('https://customer.example/')).rejects.toThrow('локальный');
    expect(mock.fetch).not.toHaveBeenCalled();
  });
  it('проверяет перенаправления и не передаёт приватную цель транспорту', async () => {
    mock.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }));
    await expect(getDocument('https://customer.example/')).rejects.toThrow('локальный');
    expect(mock.fetch).toHaveBeenCalledTimes(1);
    expect(mock.destroy).toHaveBeenCalledTimes(1);
  });
  it('при выходе с доверенного провайдера закрепляет IP новой цели', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:8888');
    mock.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://customer.example/job' } }));
    await getDocument('https://connect.tg/order-contact');
    expect(mock.fetch.mock.calls[0]![0].hostname).toBe('connect.tg');
    expect(mock.fetch.mock.calls[1]![0].hostname).toBe('8.8.8.8');
  });
  it('освобождает транспорт при сетевой ошибке', async () => {
    mock.fetch.mockRejectedValue(new Error('Сеть недоступна'));
    await expect(getDocument('https://customer.example/')).rejects.toThrow('Сеть');
    expect(mock.destroy).toHaveBeenCalledTimes(1);
  });
  it('учитывает NO_PROXY без совпадения с похожими доменами', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:8888', NO_PROXY: '.example.com:443' };
    expect(proxyFor(new URL('https://sub.example.com'), env)).toBeUndefined();
    expect(proxyFor(new URL('https://evil-example.com'), env)).toBe(env.HTTPS_PROXY);
    expect(proxyFor(new URL('https://example.com:444'), env)).toBe(env.HTTPS_PROXY);
  });
});
