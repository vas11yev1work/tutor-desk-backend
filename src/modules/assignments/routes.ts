import { sValidator } from '@hono/standard-validator';
import type { Context } from 'hono';
import { Hono } from 'hono';
import * as v from 'valibot';

import { getDb } from '../../db';
import { ApiError } from '../../lib/errors';
import { onInvalid } from '../../lib/validation';
import { ASSIGNMENT_KINDS } from './schema';
import { deleteAssignment, fileResponse, scoreMock } from './service';

/** multipart/form-data: поле `file` (PDF) и `kind`. */
export const readUpload = async (c: Context) => {
  const body = await c.req.parseBody();
  if (!(body.file instanceof File)) throw new ApiError(400, 'validation_error', 'file: нужен файл');
  const kind = ASSIGNMENT_KINDS.find(k => k === body.kind);
  if (!kind) throw new ApiError(400, 'validation_error', `kind: ожидается ${ASSIGNMENT_KINDS.join(' | ')}`);
  return { file: body.file, kind };
};

export const assignmentsRoutes = new Hono<{ Bindings: Env }>()
  .get('/:id/file', c => fileResponse(getDb(c.env), c.env.FILES, c.req.param('id')))
  .put(
    '/:id/score',
    sValidator(
      'json',
      v.object({
        scores: v.nullable(v.array(v.pipe(v.number(), v.integer(), v.minValue(0)))),
        comment: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(2000)))),
      }),
      onInvalid,
    ),
    async c => c.json(await scoreMock(getDb(c.env), c.req.param('id'), c.req.valid('json'))),
  )
  .delete('/:id', async c => {
    await deleteAssignment(getDb(c.env), c.env.FILES, c.req.param('id'));
    return c.body(null, 204);
  });
