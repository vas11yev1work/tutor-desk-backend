import { viewHtml } from './runtime';

/** Расписание за период (get_lessons): занятия по дням. */
export const weekView = viewHtml(
  'Расписание',
  `
function render(data) {
  const days = new Map();
  for (const l of data.lessons) {
    const day = l.startsAt.slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(l);
  }
  const active = data.lessons.filter(l => l.status !== 'cancelled').length;
  return el('div', { class: 'stack' },
    el('div', { class: 'card-head', style: 'border:0;padding:0 2px' },
      el('h2', null, 'Расписание'),
      el('span', { class: 'muted' }, plural(active, 'занятие', 'занятия', 'занятий')),
    ),
    days.size
      ? [...days].map(([day, lessons]) => el('section', { class: 'card' },
          el('div', { class: 'card-head' }, el('h3', null, dayTitle(day, lessons[0].weekday)), el('span', { class: 'sub' }, plural(lessons.length, 'занятие', 'занятия', 'занятий'))),
          lessons.map(l => lessonRow(l)),
        ))
      : el('div', { class: 'card empty' }, 'Занятий нет'),
  );
}
`,
);
