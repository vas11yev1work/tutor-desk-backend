import { sValidator } from '@hono/standard-validator';
import { Hono } from 'hono';
import * as v from 'valibot';

import { getDb } from '../../db';
import { isoDate, isoTimestamp, onInvalid, rangeQuery } from '../../lib/validation';
import {
  changeSeries,
  createLesson,
  createSeries,
  endSeries,
  listLessons,
  setLessonStatus,
  updateLesson,
} from './service';
import { isTimeZone } from './time';

const durationMin = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(24 * 60));

const rule = {
  weekday: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(7)),
  startTime: v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Ожидается HH:MM')),
  durationMin,
  timezone: v.pipe(v.string(), v.check(isTimeZone, 'Неизвестный часовой пояс')),
};

export const seriesRoutes = new Hono<{ Bindings: Env }>()
  .post('/', sValidator('json', v.object({ studentId: v.string(), startsOn: isoDate, ...rule }), onInvalid), async c =>
    c.json(await createSeries(getDb(c.env), c.req.valid('json'), Date.now()), 201),
  )
  .post('/:id/change', sValidator('json', v.object({ fromDate: isoDate, ...rule }), onInvalid), async c =>
    c.json(await changeSeries(getDb(c.env), c.req.param('id'), c.req.valid('json'), Date.now()), 201),
  )
  .post('/:id/end', sValidator('json', v.object({ fromDate: isoDate }), onInvalid), async c => {
    await endSeries(getDb(c.env), c.req.param('id'), c.req.valid('json').fromDate, Date.now());
    return c.body(null, 204);
  });

export const lessonsRoutes = new Hono<{ Bindings: Env }>()
  .get('/', sValidator('query', rangeQuery, onInvalid), async c =>
    c.json(await listLessons(getDb(c.env), c.req.valid('query'))),
  )
  .post(
    '/',
    sValidator('json', v.object({ studentId: v.string(), startsAt: isoTimestamp, durationMin }), onInvalid),
    async c => c.json(await createLesson(getDb(c.env), c.req.valid('json')), 201),
  )
  .patch(
    '/:id',
    sValidator(
      'json',
      v.object({ startsAt: v.optional(isoTimestamp), durationMin: v.optional(durationMin) }),
      onInvalid,
    ),
    async c => c.json(await updateLesson(getDb(c.env), c.req.param('id'), c.req.valid('json'))),
  )
  .post('/:id/cancel', async c => c.json(await setLessonStatus(getDb(c.env), c.req.param('id'), 'cancelled')))
  .post('/:id/restore', async c => c.json(await setLessonStatus(getDb(c.env), c.req.param('id'), 'scheduled')));
