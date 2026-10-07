import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

import { getDb } from '../../db';
import { adminApi, type AdminAuth, api, loginAsAdmin } from '../../test/helpers';
import type { Lesson } from '../schedule/schema';
import type { Student } from '../students/schema';
import { fileKey } from './schema';
import { sweepOrphanFiles } from './service';

const DAY = 24 * 60 * 60 * 1000;

let auth: AdminAuth;
beforeAll(async () => {
  auth = await loginAsAdmin();
});

const pdf = (name = 'ДЗ_проценты.pdf', text = 'homework') => new File([`%PDF-1.7\n${text}`], name);

const upload = (path: string, file: File, kind?: string) => {
  const body = new FormData();
  body.append('file', file);
  if (kind) body.append('kind', kind);
  return api(path, { method: 'POST', headers: auth, body });
};

type Uploaded = { id: string; kind: string; lessonId: string; fileName: string; size: number };
type ListedLesson = Lesson & { assignments: Uploaded[] };

const uploadOk = async (path: string, file: File, kind?: string) => {
  const res = await upload(path, file, kind);
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json<Uploaded>();
};

const setup = async () => {
  const student = await (
    await adminApi(auth, '/admin/students', { method: 'POST', body: { name: 'Маша' } })
  ).json<Student>();
  const startsAt = new Date(Date.now() + 2 * DAY).toISOString();
  const lesson = await (
    await adminApi(auth, '/admin/lessons', {
      method: 'POST',
      body: { studentId: student.id, startsAt, durationMin: 60 },
    })
  ).json<Lesson>();
  return { student, lesson };
};

const range = `from=${new Date().toISOString()}&to=${new Date(Date.now() + 7 * DAY).toISOString()}`;

describe('задания: домашки и пробники', () => {
  it('несколько файлов на занятие видны в списке, в одном занятии и у ученика', async () => {
    const { student, lesson } = await setup();
    const hw1 = await uploadOk(`/admin/lessons/${lesson.id}/assignments`, pdf(), 'homework');
    const hw2 = await uploadOk(`/admin/lessons/${lesson.id}/assignments`, pdf('ДЗ_2.pdf'), 'homework');
    const mock = await uploadOk(`/admin/lessons/${lesson.id}/assignments`, pdf('Вариант 1.pdf'), 'mock');
    expect(hw1).toMatchObject({ kind: 'homework', lessonId: lesson.id, fileName: 'ДЗ_проценты.pdf' });

    const ids = (l?: { assignments: { id: string }[] }) => l?.assignments.map(a => a.id);
    const list = await (await adminApi(auth, `/admin/students/${student.id}/lessons?${range}`)).json<ListedLesson[]>();
    expect(ids(list.find(l => l.id === lesson.id))).toEqual([hw1.id, hw2.id, mock.id]);
    expect(ids(await (await adminApi(auth, `/admin/lessons/${lesson.id}`)).json<ListedLesson>())).toEqual([
      hw1.id,
      hw2.id,
      mock.id,
    ]);

    const portal = await (await api(`/s/${student.accessToken}/lessons?${range}`)).json<ListedLesson[]>();
    expect(portal[0]?.assignments).toEqual([
      { id: hw1.id, kind: 'homework', fileName: 'ДЗ_проценты.pdf' },
      { id: hw2.id, kind: 'homework', fileName: 'ДЗ_2.pdf' },
      { id: mock.id, kind: 'mock', fileName: 'Вариант 1.pdf' },
    ]);
  });

  it('пробники выдаются к занятиям; вкладка пробников нумерует их по порядку', async () => {
    const { student, lesson } = await setup();
    const startsAt = new Date(Date.now() + 3 * DAY).toISOString();
    const later = await (
      await adminApi(auth, '/admin/lessons', {
        method: 'POST',
        body: { studentId: student.id, startsAt, durationMin: 60 },
      })
    ).json<Lesson>();
    const first = await uploadOk(`/admin/lessons/${lesson.id}/assignments`, pdf('П1.pdf'), 'mock');
    await uploadOk(`/admin/lessons/${lesson.id}/assignments`, pdf(), 'homework');
    const second = await uploadOk(`/admin/lessons/${later.id}/assignments`, pdf('П2.pdf'), 'mock');

    const mocks = await (await adminApi(auth, `/admin/students/${student.id}/mocks`)).json<Uploaded[]>();
    expect(mocks).toMatchObject([
      { id: first.id, number: 1, lessonId: lesson.id },
      { id: second.id, number: 2, lessonId: later.id },
    ]);
    const portal = await (await api(`/s/${student.accessToken}/mocks`)).json();
    expect(portal).toMatchObject([
      { id: first.id, number: 1, fileName: 'П1.pdf' },
      { id: second.id, number: 2, fileName: 'П2.pdf' },
    ]);
  });

  it('скачивание: PDF inline для админа и своего ученика, чужому — 404', async () => {
    const { student, lesson } = await setup();
    const other = await setup();
    const hw = await uploadOk(`/admin/lessons/${lesson.id}/assignments`, pdf('ДЗ №1.pdf', 'секрет'), 'homework');

    for (const res of [
      await adminApi(auth, `/admin/assignments/${hw.id}/file`),
      await api(`/s/${student.accessToken}/files/${hw.id}`),
    ]) {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('content-disposition')).toBe(
        `inline; filename*=UTF-8''${encodeURIComponent('ДЗ №1.pdf')}`,
      );
      expect(await res.text()).toBe('%PDF-1.7\nсекрет');
    }
    expect((await api(`/s/${other.student.accessToken}/files/${hw.id}`)).status).toBe(404);
  });

  it('валидация: не PDF, без kind, без файла, больше 20 МБ, нет занятия', async () => {
    const { student, lesson } = await setup();
    const path = `/admin/lessons/${lesson.id}/assignments`;
    const cases: [Promise<Response>, number, string][] = [
      [upload(path, new File(['<html>'], 'fake.pdf'), 'homework'), 400, 'not_pdf'],
      [upload(path, pdf()), 400, 'validation_error'],
      [upload(path, pdf(), 'essay'), 400, 'validation_error'],
      [api(path, { method: 'POST', headers: auth, body: new FormData() }), 400, 'validation_error'],
      [
        upload(path, new File(['%PDF-', new Uint8Array(20 * 1024 * 1024)], 'big.pdf'), 'homework'),
        413,
        'file_too_large',
      ],
      [upload('/admin/lessons/nope/assignments', pdf(), 'homework'), 404, 'not_found'],
    ];
    for (const [req, status, code] of cases) {
      const res = await req;
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ error: { code } });
    }
    expect(await (await adminApi(auth, `/admin/students/${student.id}/mocks`)).json()).toEqual([]);
  });

  it('удаление файла убирает его из R2; повторно → 404', async () => {
    const { student, lesson } = await setup();
    const hw = await uploadOk(`/admin/lessons/${lesson.id}/assignments`, pdf(), 'homework');
    const key = fileKey({ id: hw.id, studentId: student.id });
    expect(await env.FILES.head(key)).not.toBeNull();

    const del = () => adminApi(auth, `/admin/assignments/${hw.id}`, { method: 'DELETE' });
    expect((await del()).status).toBe(204);
    expect(await env.FILES.head(key)).toBeNull();
    expect((await del()).status).toBe(404);
  });

  it('задания удаляются с занятием и учеником, cron чистит файлы без строк', async () => {
    const { student, lesson } = await setup();
    const hw = await uploadOk(`/admin/lessons/${lesson.id}/assignments`, pdf(), 'homework');
    const startsAt = new Date(Date.now() + 3 * DAY).toISOString();
    const other = await (
      await adminApi(auth, '/admin/lessons', {
        method: 'POST',
        body: { studentId: student.id, startsAt, durationMin: 60 },
      })
    ).json<Lesson>();
    const mock = await uploadOk(`/admin/lessons/${other.id}/assignments`, pdf(), 'mock');
    const keep = await setup();
    const kept = await uploadOk(`/admin/lessons/${keep.lesson.id}/assignments`, pdf(), 'mock');

    expect((await adminApi(auth, `/admin/lessons/${lesson.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await adminApi(auth, `/admin/assignments/${hw.id}/file`)).status).toBe(404);
    expect((await adminApi(auth, `/admin/students/${student.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await adminApi(auth, `/admin/assignments/${mock.id}/file`)).status).toBe(404);

    const db = getDb(env);
    // Свежие файлы cron не трогает: строка в БД могла ещё не записаться.
    await sweepOrphanFiles(db, env.FILES, Date.now());
    expect(await env.FILES.head(fileKey({ id: hw.id, studentId: student.id }))).not.toBeNull();

    await sweepOrphanFiles(db, env.FILES, Date.now() + 2 * 60 * 60 * 1000);
    expect(await env.FILES.head(fileKey({ id: hw.id, studentId: student.id }))).toBeNull();
    expect(await env.FILES.head(fileKey({ id: mock.id, studentId: student.id }))).toBeNull();
    expect(await env.FILES.head(fileKey({ id: kept.id, studentId: keep.student.id }))).not.toBeNull();
  });
});
