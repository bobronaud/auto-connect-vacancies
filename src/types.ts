export const SPECIALIZATIONS = [
  'Фронтенд-разработка', 'Фулстек-разработка', 'Разработка чат-ботов',
  'Telegram-разработка', 'Мобильная разработка',
] as const;

export type Order = {
  id: string;
  url: string;
  title: string;
  description: string;
  skills: string;
  platform: string;
  specializations: string[];
  open: boolean;
  budget: string;
  sourceUrl: string | null;
  contact: string | null;
  contactReason: string | null;
  collectedAt: string;
};

export type AttemptStatus = 'sending' | 'sent' | 'failed' | 'unconfirmed' | 'skipped' | 'draft';
export type Attempt = {
  id: number;
  orderId: string;
  snapshot: Order;
  letter: string;
  recipient: string | null;
  status: AttemptStatus;
  detail: string;
  messageId: number | null;
  createdAt: string;
};

export function hasForbiddenKeyword(o: Order, excludedKeywords: readonly string[] = []): boolean {
  return [o.title, o.description, o.skills, o.platform, ...o.specializations,
    o.budget, o.sourceUrl, o.contact].some(value => excludedKeywords.some(keyword => keyword.trim() !== '' &&
      (value ?? '').toLowerCase().includes(keyword.trim().toLowerCase())));
}

export function isRelevant(o: Order, excludedKeywords: readonly string[] = []): boolean {
  return !hasForbiddenKeyword(o, excludedKeywords) && o.open && /^Telegram(?:-чат)?$/i.test(o.platform.trim()) &&
    o.specializations.some(s => (SPECIALIZATIONS as readonly string[]).includes(s));
}
