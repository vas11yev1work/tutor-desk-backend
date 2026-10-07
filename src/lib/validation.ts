import * as v from 'valibot';

import { ApiError } from './errors';

type Issue = { message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> };

/** Hook для sValidator: невалидный ввод → 400 validation_error. */
export const onInvalid = (result: { success: boolean; error?: readonly Issue[] }) => {
  if (result.success) return;
  const message = (result.error ?? [])
    .map(issue => {
      const path = issue.path?.map(p => String(typeof p === 'object' ? p.key : p)).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
  throw new ApiError(400, 'validation_error', message);
};

/** ISO 8601 timestamp (`2026-10-07T18:00:00Z`, с offset) → Date. */
export const isoTimestamp = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.transform(s => new Date(s)),
);

/** `YYYY-MM-DD`. */
export const isoDate = v.pipe(v.string(), v.isoDate());

/** Диапазон `?from=&to=` для списков занятий. */
export const rangeQuery = v.pipe(
  v.object({ from: isoTimestamp, to: isoTimestamp }),
  v.check(({ from, to }) => from < to, 'from должен быть раньше to'),
);
