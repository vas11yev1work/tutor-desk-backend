import { viewHtml } from './runtime';

/** Карточка ученика (get_student): профиль, ближайшие занятия, регулярное расписание, пробники. */
export const studentView = viewHtml(
  'Ученик',
  `
const EVERY = { пн: 'по понедельникам', вт: 'по вторникам', ср: 'по средам', чт: 'по четвергам', пт: 'по пятницам', сб: 'по субботам', вс: 'по воскресеньям' };

function render(data) {
  const s = data.student;
  const section = (title, body) => el('section', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', null, title)), body);
  const profile = [
    ['Класс', s.grade ? s.grade + ' класс' : null],
    ['Telegram', telegram(s.contact)],
    ['Заметки', s.notes],
  ].filter(([, v]) => v);
  const mocks = data.mocks.items;
  return el('div', { class: 'stack' },
    el('div', { class: 'card-head', style: 'border:0;padding:0 2px' }, el('h2', null, s.name), examTag(s.exam)),
    profile.length ? el('section', { class: 'card' }, el('div', { class: 'kv' }, profile.flatMap(([k, v]) => [el('span', { class: 'sub' }, k), el('span', { style: 'white-space:pre-wrap' }, v)]))) : null,
    section('Ближайшие занятия', data.upcoming.length
      ? data.upcoming.map(l => lessonRow(l, null, true))
      : el('div', { class: 'empty' }, 'В ближайшие две недели занятий нет')),
    data.series.length ? section('Регулярно', data.series.map(r => el('div', { class: 'row' },
      el('div', { class: 'time' }, r.startTime),
      el('div', null, el('div', null, EVERY[r.weekday] || r.weekday), el('div', { class: 'sub' }, r.durationMin + ' мин' + (r.endsOn ? ' · до ' + dayTitle(r.endsOn) : ''))),
      el('div'),
    ))) : null,
    s.exam || mocks.length ? section('Пробники', mocks.length ? mocks.map(m => el('div', { class: 'row' },
      el('div', { class: 'time' }, '№' + m.number),
      el('div', null,
        el('div', { class: 'sub' }, dayTitle(m.lessonDate)),
        m.total === null || !data.mocks.max ? null : el('div', { class: 'bar', style: 'margin-top:6px' }, el('i', { style: 'width:' + Math.round((m.total / data.mocks.max) * 100) + '%' })),
      ),
      m.total === null ? el('span', { class: 'tag' }, 'не проверен') : el('span', { class: 'time' }, m.total + (data.mocks.max ? ' / ' + data.mocks.max : '')),
    )) : el('div', { class: 'empty' }, 'Пробников ещё не было')) : null,
  );
}
`,
);
