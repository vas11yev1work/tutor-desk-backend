import { beforeAll, describe, expect, it } from 'vitest';

import { adminApi, type AdminAuth, api, loginAsAdmin } from '../../test/helpers';
import type { Lesson } from '../schedule/schema';
import type { Student } from '../students/schema';

const DAY = 24 * 60 * 60 * 1000;

let auth: AdminAuth;
beforeAll(async () => {
  auth = await loginAsAdmin();
});

const range = `from=${new Date().toISOString()}&to=${new Date(Date.now() + 30 * DAY).toISOString()}`;

const studentWithLesson = async (name: string) => {
  const student = await (
    await adminApi(auth, '/admin/students', {
      method: 'POST',
      body: { name, grade: 9, exam: 'oge', contact: '+7 900', notes: 'секрет' },
    })
  ).json<Student>();
  const lesson = await (
    await adminApi(auth, '/admin/lessons', {
      method: 'POST',
      body: { studentId: student.id, startsAt: new Date(Date.now() + DAY).toISOString(), durationMin: 60 },
    })
  ).json<Lesson>();
  return { student, lesson };
};

describe('/api/s/:token', () => {
  it('свой токен без cookie → 200, только публичные поля и только свои занятия', async () => {
    const { student, lesson } = await studentWithLesson('Катя');
    await studentWithLesson('Чужой');

    const profile = await api(`/s/${student.accessToken}`);
    expect(profile.status).toBe(200);
    expect(await profile.json()).toEqual({ name: 'Катя', grade: 9, exam: 'oge', theme: 'lime', examMax: 31 });

    const res = await api(`/s/${student.accessToken}/lessons?${range}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toMatch(/access_?token|contact|notes/i);
    expect(JSON.parse(body)).toEqual([
      {
        id: lesson.id,
        startsAt: lesson.startsAt,
        originalStartsAt: null,
        durationMin: 60,
        status: 'scheduled',
        assignments: [],
      },
    ]);
  });

  it('неверный, старый токен и удалённый ученик → 404', async () => {
    const { student } = await studentWithLesson('Дима');
    expect((await api('/s/wrong-token')).status).toBe(404);
    expect((await api(`/s/wrong-token/lessons?${range}`)).status).toBe(404);

    const regenerated = await (
      await adminApi(auth, `/admin/students/${student.id}/regenerate-token`, { method: 'POST' })
    ).json<Student>();
    expect((await api(`/s/${student.accessToken}`)).status).toBe(404);
    expect((await api(`/s/${regenerated.accessToken}`)).status).toBe(200);

    await adminApi(auth, `/admin/students/${student.id}`, { method: 'DELETE' });
    expect((await api(`/s/${regenerated.accessToken}`)).status).toBe(404);
  });

  it('изменяющих эндпоинтов нет', async () => {
    const { student } = await studentWithLesson('Лена');
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      expect((await api(`/s/${student.accessToken}`, { method })).status).toBe(404);
    }
  });
});
