import { viewHtml } from './runtime';

/** Список учеников (list_students). */
export const studentsView = viewHtml(
  'Ученики',
  `
function render(students) {
  return el('div', { class: 'stack' },
    el('div', { class: 'card-head', style: 'border:0;padding:0 2px' },
      el('h2', null, 'Ученики'),
      el('span', { class: 'muted' }, plural(students.length, 'ученик', 'ученика', 'учеников')),
    ),
    students.length
      ? el('section', { class: 'card' }, el('table', null,
          el('thead', null, el('tr', null, el('th', null, 'Имя'), el('th', null, 'Экзамен'), el('th', { class: 'num' }, 'Пробники'))),
          el('tbody', null, students.map(s => el('tr', null,
            el('td', null, el('div', null, s.name), el('div', { class: 'sub' }, dotted(s.grade ? s.grade + ' класс' : null, telegram(s.contact)))),
            el('td', null, examTag(s.exam) || el('span', { class: 'sub' }, '—')),
            el('td', { class: 'num' }, s.mocks ? s.scoredMocks + ' / ' + s.mocks : el('span', { class: 'sub' }, '—')),
          ))),
        ))
      : el('div', { class: 'card empty' }, 'Учеников пока нет'),
  );
}
`,
);
