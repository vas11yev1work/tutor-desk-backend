import { html } from 'hono/html';

import { layout, linkRow } from './layout';

/** Битый или чужой OAuth-запрос: обратно в Claude не редиректим. */
export const badRequestPage = () =>
  layout(
    'Неверный запрос',
    html`${linkRow(true)}
      <div class="head">
        <h1>Неверный запрос</h1>
        <p class="sub">Ссылка на подключение неполная или устарела. Начните подключение заново из Claude.</p>
      </div>`,
  );
