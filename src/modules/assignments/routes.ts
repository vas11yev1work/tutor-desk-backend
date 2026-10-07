import type { Context } from 'hono';
import { Hono } from 'hono';

import { getDb } from '../../db';
import { ApiError } from '../../lib/errors';
import { type Assignment, ASSIGNMENT_KINDS } from './schema';
import { deleteAssignment, fileResponse } from './service';

/** multipart/form-data: поле `file` (PDF) и, если нужно, `kind`. */
export const readUpload = async (c: Context) => {
  const body = await c.req.parseBody();
  if (!(body.file instanceof File)) throw new ApiError(400, 'validation_error', 'file: нужен файл');
  const kind = body.kind;
  return { file: body.file, kind: ASSIGNMENT_KINDS.find(k => k === kind) };
};

export const readLessonUpload = async (c: Context): Promise<{ file: File; kind: Assignment['kind'] }> => {
  const { file, kind } = await readUpload(c);
  if (!kind) throw new ApiError(400, 'validation_error', `kind: ожидается ${ASSIGNMENT_KINDS.join(' | ')}`);
  return { file, kind };
};

export const assignmentsRoutes = new Hono<{ Bindings: Env }>()
  .get('/:id/file', c => fileResponse(getDb(c.env), c.env.FILES, c.req.param('id')))
  .delete('/:id', async c => {
    await deleteAssignment(getDb(c.env), c.env.FILES, c.req.param('id'));
    return c.body(null, 204);
  });
