import { viewHtml } from './runtime';

/** День (get_today): прошедшие приглушены, текущее и следующее подсвечены. */
export const todayView = viewHtml(
  'Сегодня',
  `
function render(data) {
  const now = Date.parse(data.now);
  const live = data.lessons.filter(l => l.status !== 'cancelled');
  const end = l => Date.parse(l.startsAt) + l.durationMin * 60000;
  const current = live.find(l => Date.parse(l.startsAt) <= now && now < end(l));
  const next = live.find(l => Date.parse(l.startsAt) > now);
  const left = live.filter(l => end(l) > now).length;
  const status = l => (l === current ? 'now' : end(l) <= now ? 'past' : null);
  const label = l => (l === current ? 'идёт сейчас' : l === next ? 'следующее' : null);
  return el('div', { class: 'stack' },
    el('div', { class: 'card-head', style: 'border:0;padding:0 2px' },
      el('h2', null, 'Сегодня, ' + dayTitle(data.now)),
      el('span', { class: 'muted' }, live.length ? (left ? 'осталось ' + plural(left, 'занятие', 'занятия', 'занятий') : 'все занятия прошли') : ''),
    ),
    live.length || data.lessons.length
      ? el('section', { class: 'card' }, data.lessons.map(l => lessonRow(l, status(l), false, label(l))))
      : el('div', { class: 'card empty' }, 'Сегодня занятий нет'),
  );
}
`,
);
