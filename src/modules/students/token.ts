import { customAlphabet } from 'nanoid';

const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'kh',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'shch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

// 62^8 ≈ 2·10^14 вариантов: имя угадать легко, поэтому вся защита — в случайной части.
const random = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 8);

/** Первое слово имени латиницей: «Маша Иванова» → masha. */
export const nameSlug = (name: string) =>
  [...(name.trim().split(/\s+/)[0] ?? '').toLowerCase()]
    .map(ch => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20);

/** Личная ссылка ученика: masha-k7Qx2mPa; без имени — только случайная часть. */
export const newAccessToken = (name = '') => [nameSlug(name), random()].filter(Boolean).join('-');
