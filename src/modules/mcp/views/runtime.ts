/**
 * Общая часть MCP Apps-виджетов (https://modelcontextprotocol.io/extensions/apps): стили на CSS-переменных хоста
 * (Claude присылает свои цвета, шрифт, радиусы и тему) и мост postMessage без SDK.
 * Виджет — самодостаточный HTML без внешних ресурсов; данные приходят в ui/notifications/tool-result.
 * Данные вставляются только через textContent (хелпер el), никакого innerHTML.
 */

export const VIEW_MIME = 'text/html;profile=mcp-app';

const STYLES = `
:root{color-scheme:light dark}
html{background:transparent;overflow:hidden}
*{box-sizing:border-box}
body{margin:0;padding:12px;background:transparent;color:var(--color-text-primary,CanvasText);font-family:var(--font-sans,system-ui,sans-serif);font-size:var(--font-text-sm-size,14px);line-height:var(--font-text-sm-line-height,1.45)}
h2{margin:0;font-size:var(--font-heading-sm-size,16px);font-weight:var(--font-weight-semibold,600)}
h3{margin:0;font-size:var(--font-text-xs-size,12px);font-weight:var(--font-weight-medium,500);color:var(--color-text-secondary,GrayText);text-transform:uppercase;letter-spacing:.04em}
a{color:var(--color-text-info,LinkText);text-decoration:none}a:hover{text-decoration:underline}
.muted{color:var(--color-text-secondary,GrayText)}
.stack{display:flex;flex-direction:column;gap:14px}
.card{border:var(--border-width-regular,1px) solid var(--color-border-primary,color-mix(in srgb,CanvasText 14%,transparent));border-radius:var(--border-radius-lg,12px);background:var(--color-background-primary,Canvas);overflow:hidden}
.card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:var(--border-width-regular,1px) solid var(--color-border-secondary,color-mix(in srgb,CanvasText 8%,transparent))}
.row{display:grid;grid-template-columns:52px 1fr auto;gap:12px;align-items:center;padding:10px 14px}
.row+.row{border-top:var(--border-width-regular,1px) solid var(--color-border-secondary,color-mix(in srgb,CanvasText 8%,transparent))}
.time{font-variant-numeric:tabular-nums;font-weight:var(--font-weight-semibold,600)}
.sub{font-size:var(--font-text-xs-size,12px);color:var(--color-text-secondary,GrayText)}
.tags{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end}
.tag{display:inline-block;padding:1px 8px;border-radius:var(--border-radius-full,999px);font-size:var(--font-text-xs-size,12px);background:var(--color-background-secondary,color-mix(in srgb,CanvasText 7%,transparent));color:var(--color-text-secondary,GrayText);white-space:nowrap}
.tag.info{background:var(--color-background-info,light-dark(#e6f0ff,#1c2f4d));color:var(--color-text-info,light-dark(#1d4ed8,#93b8f5))}
.tag.success{background:var(--color-background-success,light-dark(#e7f6ec,#173a25));color:var(--color-text-success,light-dark(#15803d,#86d9a3))}
.tag.warning{background:var(--color-background-warning,light-dark(#fff4e0,#45300f));color:var(--color-text-warning,light-dark(#a15c00,#f2c174))}
.tag.danger{background:var(--color-background-danger,light-dark(#fdecec,#4a1d1d));color:var(--color-text-danger,light-dark(#b91c1c,#f3a3a3))}
.cancelled .name,.cancelled .time{text-decoration:line-through;color:var(--color-text-tertiary,GrayText)}
.past{opacity:.55}
.now{background:var(--color-background-info,light-dark(#e6f0ff,#1c2f4d))}
.empty{padding:18px 14px;color:var(--color-text-secondary,GrayText)}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-weight:var(--font-weight-medium,500);font-size:var(--font-text-xs-size,12px);color:var(--color-text-secondary,GrayText);padding:8px 14px}
td{padding:10px 14px;border-top:var(--border-width-regular,1px) solid var(--color-border-secondary,color-mix(in srgb,CanvasText 8%,transparent));vertical-align:top}
.num{text-align:right;font-variant-numeric:tabular-nums}
.bar{height:6px;border-radius:999px;background:var(--color-background-secondary,color-mix(in srgb,CanvasText 8%,transparent));overflow:hidden}
.bar>i{display:block;height:100%;background:var(--color-text-info,light-dark(#2563eb,#93b8f5))}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;padding:12px 14px}
/* На узком экране плашки уходят под имя; .keep — строки, где справа число, а не плашки. */
@media (max-width:420px){.row:not(.keep){grid-template-columns:44px 1fr}.row:not(.keep) .tags{grid-column:2;justify-content:flex-start}.row.keep{grid-template-columns:44px 1fr auto}}
`;

/** Мост к хосту и общие хелперы; вызывает render(data) из скрипта конкретного виджета. */
const RUNTIME = `
const EXAMS = { oge: 'ОГЭ', ege_base: 'ЕГЭ база', ege_profile: 'ЕГЭ профиль' };
const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid instanceof Node ? kid : String(kid));
  return node;
}
const time = iso => iso.slice(11, 16);
const dayTitle = (iso, weekday) => (weekday ? weekday + ', ' : '') + Number(iso.slice(8, 10)) + ' ' + MONTHS[Number(iso.slice(5, 7)) - 1];
const plural = (n, one, few, many) => {
  const d = n % 10, t = n % 100;
  return n + ' ' + (d === 1 && t !== 11 ? one : d >= 2 && d <= 4 && (t < 12 || t > 14) ? few : many);
};
/** Контакт — Telegram-юзернейм (сервер хранит без @, старые записи чистим тем же правилом, что telegramUsername). */
function telegram(contact) {
  const username = (contact || '').trim().replace(/^(telegram|телеграм|tg|тг)\\s*:?\\s*/i, '').replace(/^(https?:\\/\\/)?(t\\.me|telegram\\.me)\\//i, '').replace(/^@/, '').trim();
  if (!username) return null;
  const url = 'https://t.me/' + encodeURIComponent(username);
  const link = el('a', { href: url, target: '_blank', rel: 'noopener' }, '@' + username);
  link.addEventListener('click', event => {
    event.preventDefault();
    request('ui/open-link', { url });
  });
  return link;
}
/** Элементы через « · », пустые пропускаются. */
const dotted = (...parts) => parts.filter(Boolean).flatMap((part, i) => (i ? [' · ', part] : [part]));
const examTag = exam => (exam ? el('span', { class: 'tag' }, EXAMS[exam] || exam) : null);
const fileTags = files => files.map(f => el('span', { class: f.kind === 'mock' ? 'tag warning' : 'tag info' }, f.kind === 'mock' ? 'пробник' : 'домашка'));

/** Строка занятия: время, ученик (или дата — в карточке ученика), длительность, перенос, отмена, файлы; badge — метка первой плашкой. */
function lessonRow(l, extraClass, withDate, badge) {
  const cancelled = l.status === 'cancelled';
  const tags = [badge ? el('span', { class: 'tag success' }, badge) : null, cancelled ? el('span', { class: 'tag danger' }, 'отменено') : null, withDate ? null : examTag(l.student.exam), ...fileTags(l.assignments)].filter(Boolean);
  return el('div', { class: ['row', cancelled && 'cancelled', extraClass].filter(Boolean).join(' ') },
    el('div', { class: 'time' }, time(l.startsAt)),
    el('div', null,
      el('div', { class: 'name' }, withDate ? dayTitle(l.startsAt, l.weekday) : l.student.name),
      el('div', { class: 'sub' }, [
        l.durationMin + ' мин',
        l.regular ? 'регулярное' : 'разовое',
        l.movedFrom ? 'перенесено с ' + dayTitle(l.movedFrom) + ' ' + time(l.movedFrom) : null,
      ].filter(Boolean).join(' · ')),
    ),
    // Пустой блок плашек не рисуем: на узком экране он занял бы строку под именем.
    tags.length ? el('div', { class: 'tags' }, tags) : null,
  );
}

let nextId = 0;
const pending = new Map();
const send = message => window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, message), '*');
const request = (method, params) => new Promise(resolve => {
  const id = ++nextId;
  pending.set(id, resolve);
  send({ id, method, params });
});

function applyContext(ctx) {
  if (!ctx) return;
  const root = document.documentElement;
  if (ctx.theme) root.style.colorScheme = ctx.theme;
  for (const [name, value] of Object.entries((ctx.styles && ctx.styles.variables) || {})) root.style.setProperty(name, value);
  const fonts = ctx.styles && ctx.styles.css && ctx.styles.css.fonts;
  if (fonts && !document.getElementById('host-fonts')) document.head.append(el('style', { id: 'host-fonts' }, fonts));
}

function show(result) {
  let data = result && result.structuredContent;
  if (!data) {
    const text = result && result.content && result.content[0] && result.content[0].text;
    try { data = JSON.parse(text); } catch { data = null; }
  }
  const app = document.getElementById('app');
  app.className = '';
  if (!data || (result && result.isError)) app.replaceChildren(el('div', { class: 'empty' }, (result && result.content && result.content[0] && result.content[0].text) || 'Нет данных'));
  else app.replaceChildren(render(data));
}

window.addEventListener('message', event => {
  const msg = event.data;
  if (event.source !== window.parent || !msg || msg.jsonrpc !== '2.0') return;
  if (msg.id !== undefined && !msg.method) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    if (resolve) resolve(msg.result);
    return;
  }
  if (msg.method === 'ui/notifications/tool-result') show(msg.params);
  else if (msg.method === 'ui/notifications/host-context-changed') applyContext(msg.params);
  else if (msg.id !== undefined) send({ id: msg.id, result: {} });
});

// Высота содержимого, а не scrollHeight: тот не бывает меньше текущей высоты iframe и не даёт виджету сжаться.
new ResizeObserver(() => send({ method: 'ui/notifications/size-changed', params: { height: Math.ceil(document.body.getBoundingClientRect().height) } })).observe(document.body);

request('ui/initialize', {
  protocolVersion: '2026-01-26',
  capabilities: {},
  clientInfo: { name: 'tutor-desk', version: '1.0.0' },
}).then(result => {
  applyContext(result && result.hostContext);
  send({ method: 'ui/notifications/initialized', params: {} });
});
`;

/** HTML виджета; renderJs объявляет function render(data) → Node. */
export const viewHtml = (title: string, renderJs: string) => `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${STYLES}</style>
</head>
<body>
<div id="app" class="empty">Загрузка…</div>
<script>
${renderJs}
${RUNTIME}
</script>
</body>
</html>`;
