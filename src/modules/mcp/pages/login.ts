import { html, raw } from 'hono/html';

import { ALERT_ICON, layout, linkRow } from './layout';

/** Вход репетитора с согласием; params — OAuth-параметры, едут скрытыми полями; failed — неудачная попытка. */
export const loginPage = (params: Record<string, string>, failed?: { error: string; login: string }) =>
  layout(
    'Доступ для Claude',
    html`${linkRow(false)}
      <form method="post" class="col">
        <div class="head">
          <h1>Доступ для Claude</h1>
          <p class="sub">Войдите как репетитор, чтобы подключить Claude к кабинету.</p>
        </div>
        <div class="perms">
          <div class="perm">
            <span class="pi" style="background:#D4F54C;color:#14162B">
              ${raw('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>')}
            </span>
            <span>Читать учеников, расписание и результаты пробников</span>
          </div>
          <div class="perm">
            <span class="pi" style="background:#ECEDF1;color:#4A4E68">
              ${raw('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>')}
            </span>
            <span style="color:#4A4E68">Изменять ничего не сможет</span>
          </div>
        </div>
        ${failed ? html`<div class="alert" role="alert">${ALERT_ICON}<span>${failed.error}</span></div>` : ''}
        ${Object.entries(params).map(([k, val]) => html`<input type="hidden" name="${k}" value="${val}" />`)}
        <div class="fields">
          <div class="fld">
            <label for="login">Логин</label>
            <input id="login" name="login" value="${failed?.login ?? ''}" autocomplete="username" required />
          </div>
          <div class="fld">
            <label for="password">Пароль</label>
            <input
              id="password"
              name="password"
              type="password"
              autocomplete="current-password"
              required
              ${failed ? raw('class="invalid" autofocus') : ''}
            />
          </div>
        </div>
        <button>Разрешить</button>
      </form>`,
  );
