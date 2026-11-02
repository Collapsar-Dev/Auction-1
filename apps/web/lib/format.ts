export type Lang = 'hy' | 'ru' | 'en';

export const fmtAmd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ֏');
export const fmtNum = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Время на сайте — ереванское (PRD 1). */
export function fmtDate(d: string | Date | null | undefined, opts: { ms?: boolean; dateOnly?: boolean } = {}) {
  if (!d) return '—';
  const date = new Date(d);
  const o: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Yerevan', year: 'numeric', month: '2-digit', day: '2-digit' };
  if (!opts.dateOnly) Object.assign(o, { hour: '2-digit', minute: '2-digit', hour12: false, ...(opts.ms ? { second: '2-digit' } : {}) });
  const base = new Intl.DateTimeFormat('ru-RU', o).format(date);
  return opts.ms ? `${base}.${String(date.getUTCMilliseconds()).padStart(3, '0')}` : base;
}

/** Ереван — UTC+4 без перехода на летнее время. Поле datetime-local ↔ ISO. */
export const toYerevanInput = (iso?: string | null) => {
  if (!iso) return '';
  return new Date(new Date(iso).getTime() + 4 * 3600_000).toISOString().slice(0, 16);
};
export const fromYerevanInput = (v: string) => (v ? new Date(v + ':00+04:00').toISOString() : '');

// ---------------- Сумма прописью (SC-08) ----------------
const RU_U = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const RU_UF = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const RU_T = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const RU_D = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const RU_H = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
const ruPlural = (n: number, f: [string, string, string]) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? f[0] : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? f[1] : f[2];
};
function ruTriad(n: number, fem: boolean) {
  const out: string[] = [RU_H[Math.floor(n / 100)]];
  const r = n % 100;
  if (r >= 10 && r < 20) out.push(RU_T[r - 10]);
  else out.push(RU_D[Math.floor(r / 10)], (fem ? RU_UF : RU_U)[r % 10]);
  return out.filter(Boolean).join(' ');
}
function ruWords(n: number) {
  if (n === 0) return 'ноль';
  const groups: [number, [string, string, string] | null, boolean][] = [
    [1e9, ['миллиард', 'миллиарда', 'миллиардов'], false],
    [1e6, ['миллион', 'миллиона', 'миллионов'], false],
    [1e3, ['тысяча', 'тысячи', 'тысяч'], true],
    [1, null, false],
  ];
  const out: string[] = [];
  for (const [div, forms, fem] of groups) {
    const g = Math.floor(n / div) % 1000;
    if (!g) continue;
    out.push(ruTriad(g, fem));
    if (forms) out.push(ruPlural(g, forms));
  }
  return out.join(' ');
}
const EN_U = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_D = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function enTriad(n: number) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(EN_U[h] + ' hundred');
  if (r) parts.push(r < 20 ? EN_U[r] : EN_D[Math.floor(r / 10)] + (r % 10 ? '-' + EN_U[r % 10] : ''));
  return parts.join(' ');
}
function enWords(n: number) {
  if (n === 0) return 'zero';
  const out: string[] = [];
  for (const [div, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand'], [1, '']] as const) {
    const g = Math.floor(n / div) % 1000;
    if (g) out.push(enTriad(g) + (name ? ' ' + name : ''));
  }
  return out.join(' ');
}
const HY_U = ['', 'մեկ', 'երկու', 'երեք', 'չորս', 'հինգ', 'վեց', 'յոթ', 'ութ', 'ինը'];
const HY_D = ['', 'տաս', 'քսան', 'երեսուն', 'քառասուն', 'հիսուն', 'վաթսուն', 'յոթանասուն', 'ութսուն', 'իննսուն'];
function hyTriad(n: number) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push((h > 1 ? HY_U[h] + ' ' : '') + 'հարյուր');
  if (r) {
    const d = Math.floor(r / 10);
    const u = r % 10;
    if (d === 1) parts.push(u ? 'տասն' + HY_U[u] : 'տասը');
    else parts.push(HY_D[d] + HY_U[u]);
  }
  return parts.join(' ');
}
function hyWords(n: number) {
  if (n === 0) return 'զրո';
  const out: string[] = [];
  for (const [div, name] of [[1e9, 'միլիարդ'], [1e6, 'միլիոն'], [1e3, 'հազար'], [1, '']] as const) {
    const g = Math.floor(n / div) % 1000;
    if (!g) continue;
    if (div === 1e3 && g === 1) out.push('հազար');
    else out.push(hyTriad(g) + (name ? ' ' + name : ''));
  }
  return out.join(' ');
}
export function amountInWords(n: number, lang: Lang) {
  if (!Number.isSafeInteger(n) || n < 0) return '';
  if (lang === 'ru') return ruWords(n) + ' ' + ruPlural(n, ['драм', 'драма', 'драмов']);
  if (lang === 'en') return enWords(n) + ' dram';
  return hyWords(n) + ' դրամ';
}
