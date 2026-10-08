import { beforeAll, describe, expect, it } from 'vitest';

import { adminApi, type AdminAuth, api, loginAsAdmin, ORIGIN } from '../../test/helpers';
import { telegramUsername } from './routes';
import type { Student } from './schema';
import { nameSlug, newAccessToken } from './token';

let auth: AdminAuth;
beforeAll(async () => {
  auth = await loginAsAdmin();
});

const createStudent = async (body: Record<string, unknown> = {}) => {
  const res = await adminApi(auth, '/admin/students', { method: 'POST', body: { name: 'Маша', ...body } });
  expect(res.status).toBe(201);
  return res.json<Student>();
};

describe('админские эндпоинты без cookie → 401', () => {
  it.each([
    ['GET', '/admin/students'],
    ['POST', '/admin/students'],
    ['GET', '/admin/students/x'],
    ['PATCH', '/admin/students/x'],
    ['DELETE', '/admin/students/x'],
    ['POST', '/admin/students/x/regenerate-token'],
    ['GET', '/admin/students/x/mocks'],
    ['POST', '/admin/lessons/x/assignments'],
    ['GET', '/admin/assignments/x/file'],
    ['DELETE', '/admin/assignments/x'],
    ['PUT', '/admin/assignments/x/score'],
    ['GET', '/admin/exams'],
    ['GET', '/admin/settings'],
    ['PATCH', '/admin/settings'],
    ['GET', '/admin/students/x/series'],
    ['POST', '/admin/series'],
    ['POST', '/admin/series/x/change'],
    ['POST', '/admin/series/x/end'],
    ['GET', '/admin/lessons?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z'],
    ['GET', '/admin/lessons/x'],
    ['POST', '/admin/lessons'],
    ['PATCH', '/admin/lessons/x'],
    ['DELETE', '/admin/lessons/x'],
    ['POST', '/admin/lessons/x/cancel'],
  ])('%s %s', async (method, path) => {
    const res = await api(path, { method, headers: { origin: ORIGIN } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized' } });
  });
});

describe('ученики', () => {
  it('создание, чтение, изменение', async () => {
    const created = await createStudent({ grade: 9, exam: 'oge', contact: '@masha', notes: 'любит геометрию' });
    // Контакт хранится юзернеймом без @.
    expect(created).toMatchObject({ name: 'Маша', grade: 9, exam: 'oge', contact: 'masha' });
    expect(created.accessToken).toMatch(/^masha-[0-9A-Za-z]{8}$/);

    const got = await adminApi(auth, `/admin/students/${created.id}`);
    expect(await got.json()).toEqual(created);

    const patched = await adminApi(auth, `/admin/students/${created.id}`, {
      method: 'PATCH',
      body: { grade: 11, exam: 'ege_profile', notes: null },
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ grade: 11, exam: 'ege_profile', notes: null, name: 'Маша' });
  });

  it('тема: по умолчанию lime, меняется через PATCH', async () => {
    const created = await createStudent();
    expect(created.theme).toBe('lime');
    const patched = await adminApi(auth, `/admin/students/${created.id}`, {
      method: 'PATCH',
      body: { theme: 'ocean' },
    });
    expect(await patched.json()).toMatchObject({ theme: 'ocean' });
    const empty = await adminApi(auth, `/admin/students/${created.id}`, { method: 'PATCH', body: { theme: ' ' } });
    expect(empty.status).toBe(400);
  });

  it('валидация: класс вне 1–11 и неизвестный экзамен → 400', async () => {
    for (const body of [{ name: 'А', grade: 12 }, { name: 'А', exam: 'gia' }, { name: '  ' }]) {
      const res = await adminApi(auth, '/admin/students', { method: 'POST', body });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'validation_error' } });
    }
  });

  it('несуществующий ученик → 404', async () => {
    const res = await adminApi(auth, '/admin/students/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('удаление: 204, ученик пропадает из списка, повторно → 404', async () => {
    const kept = await createStudent();
    const deleted = await createStudent();
    const del = () => adminApi(auth, `/admin/students/${deleted.id}`, { method: 'DELETE' });
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(404);

    const ids = (await (await adminApi(auth, '/admin/students')).json<Student[]>()).map(s => s.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(deleted.id);
  });

  it('regenerate-token выдаёт новый токен', async () => {
    const student = await createStudent();
    const res = await adminApi(auth, `/admin/students/${student.id}/regenerate-token`, { method: 'POST' });
    const updated = await res.json<Student>();
    expect(updated.accessToken).toMatch(/^masha-[0-9A-Za-z]{8}$/);
    expect(updated.accessToken).not.toBe(student.accessToken);
  });
});

describe('личная ссылка', () => {
  it('имя латиницей + 8 случайных символов', () => {
    expect(nameSlug('Маша Иванова')).toBe('masha');
    expect(nameSlug('  Артём ')).toBe('artem');
    expect(nameSlug('Щука-Юля')).toBe('shchukayulya');
    expect(nameSlug('John Smith')).toBe('john');
    expect(nameSlug('🙂')).toBe('');
    expect(newAccessToken('🙂')).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(newAccessToken('Аня')).toMatch(/^anya-[0-9A-Za-z]{8}$/);
  });
});

describe('telegramUsername', () => {
  it('оставляет только юзернейм', () => {
    for (const input of [
      'vera_tg',
      '@vera_tg',
      ' Telegram: @vera_tg ',
      'tg vera_tg',
      'ТГ: @vera_tg',
      'https://t.me/vera_tg',
      't.me/vera_tg',
    ]) {
      expect(telegramUsername(input), input).toBe('vera_tg');
    }
    expect(telegramUsername('  @ ')).toBeNull();
  });
});

describe('настройки кабинета', () => {
  it('тема: lime по умолчанию, PATCH сохраняет', async () => {
    expect(await (await adminApi(auth, '/admin/settings')).json()).toEqual({ theme: 'lime' });
    const patched = await adminApi(auth, '/admin/settings', { method: 'PATCH', body: { theme: 'grape' } });
    expect(await patched.json()).toEqual({ theme: 'grape' });
    expect(await (await adminApi(auth, '/admin/settings')).json()).toEqual({ theme: 'grape' });
    expect((await adminApi(auth, '/admin/settings', { method: 'PATCH', body: {} })).status).toBe(400);
  });
});
