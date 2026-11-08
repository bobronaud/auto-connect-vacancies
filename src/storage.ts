import Database from 'better-sqlite3';
import { chmodSync, closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Attempt, AttemptStatus, Order } from './types.js';
import { isRelevant } from './types.js';
import { privateDir } from './utils.js';

/** A process lock also protects the persistent Chromium profile. */
export function acquireLock(path = resolve('.data/app.lock')): () => void {
  privateDir(dirname(path));
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); }
      finally { closeSync(fd); }
      return () => {
        if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).token === token) unlinkSync(path);
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid: number;
      try { pid = Number(JSON.parse(readFileSync(path, 'utf8')).pid); }
      catch { throw new Error('Не удалось проверить .data/app.lock. Убедитесь, что другой экземпляр закрыт.'); }
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Некорректный .data/app.lock.');
      try { process.kill(pid, 0); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(path); continue; }
        throw err;
      }
      throw new Error('Приложение уже запущено. Закройте другой экземпляр.');
    }
  }
  throw new Error('Не удалось получить блокировку приложения.');
}

export class Store {
  private db: Database.Database;
  constructor(path = resolve('.data/connect.sqlite')) {
    privateDir(dirname(path));
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, collected_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL REFERENCES orders(id), snapshot TEXT NOT NULL,
        letter TEXT NOT NULL, recipient TEXT, status TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '', message_id INTEGER, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attempts_order ON attempts(order_id, status);
      PRAGMA user_version = 1;
    `);
    // A crashed send can have reached Telegram; never retry it automatically.
    this.db.prepare("UPDATE attempts SET status='unconfirmed', detail='Работа прервана во время отправки; проверьте диалог в Telegram' WHERE status='sending'").run();
  }
  close(): void { this.db.close(); }
  upsert(o: Order): void {
    this.db.prepare('INSERT INTO orders VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, collected_at=excluded.collected_at')
      .run(o.id, JSON.stringify(o), o.collectedAt);
  }
  blocked(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM attempts WHERE order_id=? AND status IN ('sent','sending','unconfirmed') LIMIT 1").get(id);
  }
  queue(): Order[] {
    const rows = this.db.prepare("SELECT payload FROM orders WHERE id NOT IN (SELECT order_id FROM attempts WHERE status IN ('sent','sending','unconfirmed')) ORDER BY collected_at DESC, id").all() as { payload: string }[];
    return rows.map(r => JSON.parse(r.payload) as Order).filter(isRelevant);
  }
  start(o: Order, letter: string, status: AttemptStatus = 'sending', detail = ''): number {
    if (this.blocked(o.id)) throw new Error('Для заказа уже существует отправленный или неподтверждённый отклик.');
    return Number(this.db.prepare('INSERT INTO attempts(order_id,snapshot,letter,recipient,status,detail,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(o.id, JSON.stringify(o), letter, o.contact, status, detail, new Date().toISOString()).lastInsertRowid);
  }
  finish(id: number, status: AttemptStatus, detail: string, messageId: number | null = null): void {
    this.db.prepare('UPDATE attempts SET status=?,detail=?,message_id=? WHERE id=?').run(status, detail, messageId, id);
  }
  history(): Attempt[] {
    const rows = this.db.prepare('SELECT * FROM attempts ORDER BY id DESC').all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: Number(r.id), orderId: String(r.order_id), snapshot: JSON.parse(String(r.snapshot)),
      letter: String(r.letter), recipient: r.recipient as string | null,
      status: r.status as AttemptStatus, detail: String(r.detail), messageId: r.message_id as number | null,
      createdAt: String(r.created_at),
    }));
  }
}
