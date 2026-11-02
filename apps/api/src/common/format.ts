/** Деньги — целые драмы; время на сайте и в письмах — ереванское. */
export const fmtAmd = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ֏';
export const fmtYerevan = (d: Date | string, withMs = false) => {
  const date = new Date(d);
  const s = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Yerevan',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
  return withMs ? `${s}.${String(date.getUTCMilliseconds()).padStart(3, '0')}` : s;
};
export type Lang = 'hy' | 'ru' | 'en';
export const LANGS: Lang[] = ['hy', 'ru', 'en'];
