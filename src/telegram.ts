import type { BrowserContext, Page } from 'playwright';
import { resolve } from 'node:path';
import type { Config } from './config.js';
import { errorText, log, privateDir, throwIfAborted } from './utils.js';

// Keep knowledge about Telegram Web K in one adapter.
export const SEL = {
  chatList: '#column-left .chatlist-chat',
  qrCanvas: "canvas[class*='qrCanvas']",
  loginButton: /log in by phone number|вход по номеру телефона/i,
  composer: ".chat.active .input-message-input[contenteditable='true']",
  outgoing: '.chat.active .bubble.is-out[data-mid]',
  messageText: '.message',
  messageNoise: '.time, .reactions, .reply-markup, .bubble-name-forwarded, .reply',
};
type Managers = {
  appUsersManager: {
    resolveUsername(username: string): Promise<{ _: string; id: number; bot?: boolean; deleted?: boolean } | null>;
    getUser(id: number): { bot?: boolean; deleted?: boolean; pFlags?: { bot?: boolean; deleted?: boolean } };
  };
};
type TgWindow = {
  im?: unknown;
  rootScope: { managers: Managers };
  appImManager: { setInnerPeer(o: { peerId: number }): Promise<void> | void; chat?: { peerId?: number } };
};

export class TelegramStop extends Error {}

export function proxyOptions(config: Config): { server: string; username?: string; password?: string } | undefined {
  const name = config.browser.proxyEnv;
  if (!name) return undefined;
  const value = process.env[name];
  if (!value) throw new Error(`Не задана переменная прокси ${name}.`);
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol)) throw new Error();
    return { server: `${url.protocol}//${url.host}`, ...(url.username ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : {}) };
  } catch { throw new Error(`Некорректный URL прокси в ${name}.`); }
}

export class Telegram {
  private context?: BrowserContext;
  private page?: Page;
  private peerId?: number;
  constructor(private config: Config, private signal?: AbortSignal) {}

  async open(headless = this.config.browser.headless): Promise<Page> {
    if (this.page) return this.page;
    throwIfAborted(this.signal);
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.data/browsers');
    const { chromium } = await import('playwright');
    this.context = await chromium.launchPersistentContext(privateDir('.data/telegram-profile'), {
      headless, viewport: { width: 1280, height: 900 }, locale: 'en-US',
      ...(this.config.browser.executablePath ? { executablePath: this.config.browser.executablePath } : {}),
      proxy: proxyOptions(this.config),
    });
    await this.context.addInitScript('globalThis.__name = (fn) => fn;');
    // QR login requires images: do not block PNG/SVG resources.
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    await this.page.goto('https://web.telegram.org/k/', { waitUntil: 'domcontentloaded' });
    return this.page;
  }
  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined; this.page = undefined; this.peerId = undefined;
    await context?.close().catch(() => undefined);
  }
  async authState(page: Page): Promise<'logged_in' | 'logged_out'> {
    const ready = page.locator(SEL.chatList).first();
    const login = page.locator(SEL.qrCanvas).or(page.getByRole('button', { name: SEL.loginButton })).first();
    await ready.or(login).first().waitFor({ timeout: 45_000 });
    return await ready.isVisible() ? 'logged_in' : 'logged_out';
  }
  async login(): Promise<void> {
    const page = await this.open(false);
    if (await this.authState(page) === 'logged_in') { log.success('Вы уже авторизованы в Telegram.'); return; }
    log.info('Отсканируйте QR-код: Telegram → Настройки → Устройства → Подключить устройство.');
    log.info('Если включена двухэтапная аутентификация, введите пароль в окне браузера.');
    await page.locator(SEL.chatList).first().waitFor({ timeout: 300_000 });
    log.success('Вход выполнен. Сессия сохранена для следующих запусков.');
  }
  async ready(): Promise<Page> {
    const page = await this.open();
    let state: 'logged_in' | 'logged_out';
    try { state = await this.authState(page); }
    catch { throw new TelegramStop('Не удалось проверить авторизацию Telegram. Очередь сохранена; проверьте вход и соединение.'); }
    if (state !== 'logged_in') throw new TelegramStop('Сначала выберите «Авторизоваться в Telegram».');
    await page.waitForFunction(() => {
      const w = window as unknown as TgWindow;
      return typeof w.im === 'function' && !!w.rootScope?.managers;
    }, null, { timeout: 30_000 });
    return page;
  }
  async prepare(username: string): Promise<void> {
    try { await this.preparePeer(username); }
    catch (e) {
      if (/FLOOD|PEER_FLOOD|USER_RESTRICTED|SESSION_REVOKED|AUTH_KEY|too many requests|USER_DEACTIVATED/i.test(errorText(e))) {
        throw new TelegramStop('Telegram ограничил аккаунт или отозвал сессию. Отправка остановлена, очередь сохранена.');
      }
      throw e;
    }
  }
  private async preparePeer(username: string): Promise<void> {
    const page = await this.ready();
    throwIfAborted(this.signal);
    const user = await page.evaluate(async name => {
      const m = (window as unknown as TgWindow).rootScope.managers;
      const p = await m.appUsersManager.resolveUsername(name);
      if (!p || p._ !== 'user' || !Number.isSafeInteger(Number(p.id)) || Number(p.id) <= 0) return null;
      const full = await m.appUsersManager.getUser(Number(p.id));
      if (p.bot || p.deleted || full?.bot || full?.deleted || full?.pFlags?.bot || full?.pFlags?.deleted) return null;
      return Number(p.id);
    }, username);
    if (!user) throw new Error('Контакт не является доступным личным аккаунтом заказчика.');
    await page.evaluate(async id => { await (window as unknown as TgWindow).appImManager.setInnerPeer({ peerId: id }); }, user);
    await page.locator(`.chat.active [data-peer-id="${user}"]`).first().waitFor({ timeout: 20_000 });
    await page.locator(SEL.composer).first().waitFor({ timeout: 20_000 });
    // Preserve any manual draft instead of appending to or overwriting it.
    if ((await page.locator(SEL.composer).first().innerText()).trim()) throw new Error('В диалоге есть черновик. Удалите его в Telegram и повторите отправку.');
    this.peerId = user;
  }
  async send(text: string): Promise<number> {
    const page = this.page;
    const peerId = this.peerId;
    if (!page || !peerId) throw new Error('Не выбран получатель.');
    throwIfAborted(this.signal);
    await page.locator(`.chat.active [data-peer-id="${peerId}"]`).first().waitFor({ timeout: 5000 });
    const before = await page.locator(SEL.outgoing).evaluateAll(nodes => nodes.map(n => n.getAttribute('data-mid')));
    if ((await page.locator(SEL.composer).first().innerText()).trim()) throw new Error('В диалоге появился черновик. Отправка отменена.');
    await page.locator(SEL.composer).first().click();
    await page.keyboard.insertText(text);
    // A second recipient check immediately precedes the only write action.
    const samePeer = await page.evaluate(id => {
      const manager = (window as unknown as TgWindow).appImManager;
      const current = manager.chat?.peerId;
      return current != null ? Number(current) === id : !!document.querySelector(`.chat.active [data-peer-id="${id}"]`);
    }, peerId);
    if (!samePeer) throw new TelegramStop('Активный диалог изменился. Отправка остановлена.');
    throwIfAborted(this.signal);
    await page.keyboard.press('Enter');
    try {
      const handle = await page.waitForFunction(({ sel, before, text }) => {
        for (const bubble of document.querySelectorAll<HTMLElement>(sel.outgoing)) {
          const mid = Number(bubble.dataset.mid);
          if (!Number.isSafeInteger(mid) || mid <= 0 || before.includes(bubble.dataset.mid ?? '') ||
            bubble.classList.contains('is-sending') || bubble.classList.contains('is-error')) continue;
          const message = bubble.querySelector(sel.messageText)?.cloneNode(true) as HTMLElement | undefined;
          message?.querySelectorAll(sel.messageNoise).forEach(e => e.remove());
          const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
          if (message && normalize(message.textContent ?? '') === normalize(text)) return mid;
        }
        return null;
      }, { sel: SEL, before, text }, { timeout: 60_000 });
      const mid = Number(await handle.jsonValue());
      await handle.dispose();
      return mid;
    } catch {
      const notice = await page.locator('.toast, .popup.active').allTextContents().catch(() => []);
      const combined = notice.join(' ');
      if (/flood|too many|spam|mutual contacts|огранич|слишком много|спам|взаимным контакт/i.test(combined)) {
        throw new TelegramStop('Telegram ограничил отправку сообщений. Проверьте аккаунт; очередь сохранена.');
      }
      throw new Error('Telegram не подтвердил отправку за 60 секунд. Проверьте диалог вручную.');
    }
  }
}
