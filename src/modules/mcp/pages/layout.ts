import { html, raw } from 'hono/html';

// Стили и иконки из макета «Доступ для Claude» (дизайн TutorDesk); строкой, чтобы Prettier не раздувал CSS.
const STYLES = `
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 16px;font-family:'Onest',system-ui,-apple-system,sans-serif;color:#14162B;-webkit-font-smoothing:antialiased;background-color:#14162B;background-image:linear-gradient(rgba(255,255,255,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.07) 1px,transparent 1px);background-size:22px 22px;background-position:-1px -1px}
.card{width:100%;max-width:440px;background:#fff;border-radius:28px;padding:32px;display:flex;flex-direction:column;gap:22px}
.col{display:flex;flex-direction:column;gap:22px}
.head{display:flex;flex-direction:column;gap:8px}
h1{margin:0;font-size:24px;font-weight:700}
.sub{margin:0;font-size:15px;line-height:1.5;color:#5A5E76}
.link{display:flex;align-items:center;gap:10px}
.tile{flex:none;width:52px;height:52px;border-radius:16px;display:flex;align-items:center;justify-content:center}
.dash{flex:1;height:0;border-top:2px dashed #C9CCD8;min-width:24px}
.lock{flex:none;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#F2F3F5;color:#4A4E68}
.lock.bad{background:#FFE6DE;color:#B4320F}
.perms{display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:18px;background:#F7F8FA;border:1px solid #E3E5EB}
.perm{display:flex;align-items:center;gap:12px;font-size:14.5px;line-height:1.4}
.pi{flex:none;width:28px;height:28px;border-radius:9px;display:flex;align-items:center;justify-content:center}
.alert{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:14px;background:#FFE6DE;color:#B4320F;font-size:14.5px;font-weight:600}
.fields{display:flex;flex-direction:column;gap:16px}
.fld{display:flex;flex-direction:column;gap:8px;min-width:0}
label{font-size:13px;font-weight:600;color:#4A4E68}
input{width:100%;height:52px;padding:0 16px;border-radius:14px;border:1px solid #D9DCE4;background:#F7F8FA;color:#14162B;font:500 16px 'Onest',system-ui,sans-serif}
input:focus{outline:2px solid #14162B;outline-offset:1px}
input.invalid{border-color:#FF7A5B}
button{display:flex;align-items:center;justify-content:center;width:100%;min-height:52px;padding:0 18px;border-radius:16px;border:0;background:#14162B;color:#fff;font:600 16px/1 'Onest',system-ui,sans-serif;cursor:pointer}
button:hover{background:#262946}
@media (max-width:760px){body{justify-content:flex-start;padding:28px 16px 32px}.card{padding:22px;border-radius:24px;gap:20px}}
`;

export const ALERT_ICON = raw(
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 6v8M12 18h.01"/></svg>',
);
const LOCK_ICON = raw(
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
);

/** Кабинет — пунктир с замком — Claude; при ошибке запроса замок красный. */
export const linkRow = (bad: boolean) =>
  html`<div class="link" aria-hidden="true">
    <div class="tile" style="background:#D4F54C;transform:rotate(-6deg)">
      ${raw('<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#14162B" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 5H6.5l6 7-6 7h11"/></svg>')}
    </div>
    <span class="dash"></span>
    <span class="lock${bad ? ' bad' : ''}">${bad ? ALERT_ICON : LOCK_ICON}</span>
    <span class="dash"></span>
    <div class="tile" style="background:#14162B;color:#fff">
      ${raw('<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M6 4.5h12A2.5 2.5 0 0 1 20.5 7v8a2.5 2.5 0 0 1-2.5 2.5h-6l-4.2 3.1a.5.5 0 0 1-.8-.4v-2.7H6A2.5 2.5 0 0 1 3.5 15V7A2.5 2.5 0 0 1 6 4.5z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><circle cx="8.5" cy="11" r="1.25" fill="currentColor"/><circle cx="12" cy="11" r="1.25" fill="currentColor"/><circle cx="15.5" cy="11" r="1.25" fill="currentColor"/></svg>')}
    </div>
  </div>`;

export type Html = ReturnType<typeof html>;

/** Страница-карточка на тёмной сетке; body — содержимое карточки. */
export const layout = (title: string, body: Html) =>
  html`<!doctype html>
    <html lang="ru">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&display=swap"
        />
        <style>
          ${raw(STYLES)}
        </style>
      </head>
      <body>
        <main class="card">${body}</main>
      </body>
    </html>`;
