import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Ошибка API в едином формате `{ error: { code, message } }`; рендерит app.onError. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string = code,
  ) {
    super(message);
  }
}

export const notFound = (message: string) => new ApiError(404, 'not_found', message);
