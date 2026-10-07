import { TZDate } from '@date-fns/tz';

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');

/** Календарная дата `YYYY-MM-DD` момента `ms` в поясе `tz`. */
export const localDate = (ms: number, tz: string) => {
  const d = new TZDate(ms, tz);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Даты без времени считаем в UTC: `Date.parse('YYYY-MM-DD')` — полночь UTC, сдвигов DST нет.
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);

export const isoWeekday = (date: string) => new Date(Date.parse(date)).getUTCDay() || 7;

/** Локальные дата + 'HH:MM' в поясе `tz` → UTC ms. Летнее/зимнее время учитывает TZDate. */
export const toUtc = (date: string, time: string, tz: string) => {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  const [hh = 0, mm = 0] = time.split(':').map(Number);
  return new TZDate(y, m - 1, d, hh, mm, tz).getTime();
};

export const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
