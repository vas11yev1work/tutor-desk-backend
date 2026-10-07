import { beforeAll, describe, expect, it } from 'vitest';

import { adminApi, type AdminAuth, loginAsAdmin } from '../../test/helpers';
import type { Student } from '../students/schema';
import type { Lesson, Series } from './schema';
import { addDays, localDate } from './time';

const ROME = 'Europe/Rome';
const DAY = 24 * 60 * 60 * 1000;

let auth: AdminAuth;
beforeAll(async () => {
  auth = await loginAsAdmin();
});

const post = async <T>(path: string, body: unknown, status = 201) => {
  const res = await adminApi(auth, path, { method: 'POST', body });
  expect(res.status, await res.clone().text()).toBe(status);
  return res.json<T>();
};

const range = () => {
  const from = new Date().toISOString();
  const to = new Date(Date.now() + 70 * DAY).toISOString();
  return `from=${from}&to=${to}`;
};

type ListedLesson = Lesson & { student: Pick<Student, 'id' | 'name' | 'grade' | 'exam'> };

const listForStudent = async (studentId: string) =>
  (await adminApi(auth, `/admin/students/${studentId}/lessons?${range()}`)).json<ListedLesson[]>();

const tomorrow = () => addDays(localDate(Date.now(), ROME), 1);

const rule = { weekday: 2, startTime: '18:00', durationMin: 60, timezone: ROME };

describe('расписание через API', () => {
  it('правило → занятия; список с данными ученика; перенос, отмена, восстановление', async () => {
    const student = await post<Student>('/admin/students', { name: 'Петя', grade: 10, exam: 'ege_base' });
    const series = await post<Series>('/admin/series', { studentId: student.id, startsOn: tomorrow(), ...rule });
    expect(series).toMatchObject({ studentId: student.id, weekday: 2, endsOn: null });

    const lessons = await listForStudent(student.id);
    expect(lessons).toHaveLength(8);
    expect(lessons[0]?.student).toEqual({ id: student.id, name: 'Петя', grade: 10, exam: 'ege_base' });

    const all = await (await adminApi(auth, `/admin/lessons?${range()}`)).json<ListedLesson[]>();
    expect(all.map(l => l.id)).toEqual(expect.arrayContaining(lessons.map(l => l.id)));

    const [first] = lessons;
    if (!first) throw new Error('no lessons');
    expect(await (await adminApi(auth, `/admin/lessons/${first.id}`)).json()).toEqual(first);
    expect((await adminApi(auth, '/admin/lessons/nope')).status).toBe(404);
    const startsAt = new Date(Date.parse(first.startsAt as unknown as string) + 3600_000).toISOString();
    const moved = await adminApi(auth, `/admin/lessons/${first.id}`, { method: 'PATCH', body: { startsAt } });
    expect(await moved.json()).toMatchObject({ startsAt, isModified: true });

    expect(await post(`/admin/lessons/${first.id}/cancel`, undefined, 200)).toMatchObject({ status: 'cancelled' });
    expect(await post(`/admin/lessons/${first.id}/restore`, undefined, 200)).toMatchObject({ status: 'scheduled' });
  });

  it('разовое занятие, изменение и завершение правила', async () => {
    const student = await post<Student>('/admin/students', { name: 'Оля' });
    const startsAt = new Date(Date.now() + 2 * DAY).toISOString();
    const oneOff = await post<Lesson>('/admin/lessons', { studentId: student.id, startsAt, durationMin: 90 });
    expect(oneOff).toMatchObject({ seriesId: null, originalStartsAt: null, durationMin: 90 });

    const series = await post<Series>('/admin/series', { studentId: student.id, startsOn: tomorrow(), ...rule });
    const fromDate = addDays(tomorrow(), 14);
    const next = await post<Series>(`/admin/series/${series.id}/change`, { fromDate, ...rule, weekday: 4 });
    expect(next).toMatchObject({ startsOn: fromDate, weekday: 4 });

    const active = await (await adminApi(auth, `/admin/students/${student.id}/series`)).json<Series[]>();
    expect(active.map(s => s.id)).toEqual([series.id, next.id]);
    expect((await adminApi(auth, '/admin/students/nope/series')).status).toBe(404);

    const ended = await adminApi(auth, `/admin/series/${next.id}/end`, { method: 'POST', body: { fromDate } });
    expect(ended.status).toBe(204);
    const left = await listForStudent(student.id);
    expect(left.every(l => l.seriesId !== next.id)).toBe(true);
    expect(left.map(l => l.id)).toContain(oneOff.id);
  });

  it('ошибки: дата в прошлом → 400, удалённый ученик → 404, неизвестный пояс → 400', async () => {
    const student = await post<Student>('/admin/students', { name: 'Ира' });
    const series = await post<Series>('/admin/series', { studentId: student.id, startsOn: tomorrow(), ...rule });

    const past = await adminApi(auth, `/admin/series/${series.id}/end`, {
      method: 'POST',
      body: { fromDate: '2020-01-01' },
    });
    expect(past.status).toBe(400);
    expect(await past.json()).toMatchObject({ error: { code: 'date_in_past' } });

    const badTz = await adminApi(auth, '/admin/series', {
      method: 'POST',
      body: { studentId: student.id, startsOn: tomorrow(), ...rule, timezone: 'Mars/Olympus' },
    });
    expect(badTz.status).toBe(400);

    expect((await adminApi(auth, `/admin/students/${student.id}`, { method: 'DELETE' })).status).toBe(204);

    const conflicts = [
      adminApi(auth, '/admin/series', {
        method: 'POST',
        body: { studentId: student.id, startsOn: tomorrow(), ...rule },
      }),
      adminApi(auth, '/admin/lessons', {
        method: 'POST',
        body: { studentId: student.id, startsAt: new Date(Date.now() + DAY).toISOString(), durationMin: 60 },
      }),
    ];
    for (const res of await Promise.all(conflicts)) {
      expect(res.status).toBe(404);
    }
  });
});
