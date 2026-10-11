// Типы модуля кассы «Мечта». Все суммы — в копейках (целые числа).

export type Category = 'alcohol' | 'tobacco' | 'energy' | 'lottery';

export interface ReceiptLine {
  /** Штрихкод EAN-13/EAN-8/GTIN-14. */
  gtin?: string;
  /** Код маркировки DataMatrix, как пришёл со сканера. */
  markCode?: string;
  /** Категория «Мечты», если касса её уже знает. */
  category?: Category;
  /** Группа товара в базе магазина; переводится через groupMap. */
  group?: string;
  /** Цена за единицу, копейки. */
  price?: number;
  qty?: number;
  /** Итог строки с учётом скидок, копейки. Важнее price * qty. */
  sum?: number;
}

export interface PosOptions {
  serverUrl: string;
  terminalId: string;
  merchantId?: string;
  apiKey?: string;
  catalog?: Record<string, { category: Category | null; name?: string }>;
  groupMap?: Record<string, Category>;
  enabled?: boolean;
  basketTimeoutMs?: number;
  statusTimeoutMs?: number;
  statusPollMs?: number;
  statusPollTotalMs?: number;
  closeTimeoutMs?: number;
  catalogTimeoutMs?: number;
  catalogRefreshMs?: number;
  fetch?: typeof fetch;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  now?: () => number;
}

export interface PaymentSession {
  basketId: string | null;
  amount: number;
  restricted: Partial<Record<Category, number>>;
  /** Категория каждой строки чека, в том же порядке. */
  lines: Array<Category | null>;
  sent: boolean;
  reason: 'sent' | 'no_restricted_items' | 'server_unavailable' | 'bad_response' | 'module_error' | 'disabled' | 'zero_amount';
  error?: string;
}

export interface DeclineInfo {
  /** true — отказ из-за запрета «Мечты»; false — обычный отказ банка или оплата прошла. */
  mechta: boolean;
  categories: Category[];
  hint: string | null;
  cashierText?: string;
  /** Индексы строк чека, которые нужно убрать. */
  removeLines: number[];
}

export interface PosModule {
  version: string;
  loadCatalog(): Promise<{ ok: boolean; size: number; version?: string | null; error?: string }>;
  classify(items: ReceiptLine[]): { total: number; restricted: Partial<Record<Category, number>>; lines: Array<Category | null> };
  beforeCardPayment(items: ReceiptLine[], amount?: number): Promise<PaymentSession>;
  afterCardResult(session: PaymentSession, approved: boolean): Promise<DeclineInfo>;
  /** Кассир отменил чек / покупатель ушёл. */
  cancel(): Promise<void>;
  removeLines<T>(items: T[], indexes: number[]): T[];
  catalogSize(): number;
  lookup(gtin: string): { category: Category | null; name?: string } | null;
  stats(): { baskets: number; skipped: number; failOpen: number; declinedByMechta: number; declinedOther: number };
}

export const VERSION: string;
export const CATEGORIES: Record<Category, string>;
export function parseScan(raw: string): { gtin: string | null; marked: boolean; raw: string };
export function normalizeGtin(code: string): string | null;
export function createPosModule(opts: PosOptions): PosModule;
