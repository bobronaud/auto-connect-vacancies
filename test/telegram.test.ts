import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { Telegram } from '../src/telegram.js';
import type { Config } from '../src/config.js';
import { validLetter } from './fixtures.js';

// Optional system browser override keeps these tests runnable without a download.
const executablePath = process.env.CONNECT_TEST_CHROMIUM ?? chromium.executablePath();
const config: Config = { browser: { headless: true }, llm: { effort: 'medium', timeoutSec: 180, maxChars: 1200, candidate: 'Опытный разработчик' }, apply: { delaySec: 0, dryRun: false } };

describe.skipIf(!existsSync(executablePath))('Telegram: синтетический диалог Chromium', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ executablePath, headless: true }); });
  afterAll(async () => { await browser.close(); });

  async function synthetic(currentPeer = 42) {
    const page = await browser.newPage();
    await page.setContent(`<div class="chat active"><div data-peer-id="42">Заказчик</div>
      <div class="bubble is-out" data-mid="10"><div class="message">Старое сообщение<span class="time">12:00</span></div></div>
      <div class="input-message-input" contenteditable="true"></div></div>`);
    await page.evaluate(peerId => {
      Object.assign(window, { appImManager: { chat: { peerId } } });
      document.querySelector('[contenteditable]')!.addEventListener('keydown', event => {
        if ((event as KeyboardEvent).key !== 'Enter') return;
        event.preventDefault();
        const input = document.querySelector<HTMLElement>('[contenteditable]')!;
        const bubble = document.createElement('div');
        bubble.className = 'bubble is-out is-sending'; bubble.dataset.mid = '11';
        const message = document.createElement('div'); message.className = 'message'; message.textContent = input.innerText;
        const time = document.createElement('span'); time.className = 'time'; time.textContent = '12:01';
        message.append(time); bubble.append(message); document.querySelector('.chat')!.append(bubble);
        input.textContent = '';
        setTimeout(() => bubble.classList.remove('is-sending'), 100);
      });
    }, currentPeer);
    const tg = new Telegram(config);
    // Inject an isolated page; no Telegram network traffic is involved.
    Object.assign(tg, { page, peerId: 42 });
    return { page, tg };
  }
  it('подтверждает точный текст только после снятия is-sending', async () => {
    const { page, tg } = await synthetic();
    expect(await tg.send(validLetter)).toBe(11);
    expect(await page.locator('.is-out').count()).toBe(2);
    expect(await page.locator('.is-sending').count()).toBe(0);
    await page.close();
  });
  it('не нажимает Enter, если активный получатель изменился', async () => {
    const { page, tg } = await synthetic(99);
    await expect(tg.send(validLetter)).rejects.toThrow('диалог изменился');
    expect(await page.locator('.is-out').count()).toBe(1);
    await page.close();
  });
});
