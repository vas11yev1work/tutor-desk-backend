import { VIEW_MIME } from './runtime';
import { studentView } from './student';
import { studentsView } from './students';
import { todayView } from './today';
import { weekView } from './week';

/** UI-ресурсы MCP Apps: инструмент ссылается на виджет через _meta.ui.resourceUri. */
export const VIEWS = {
  week: { uri: 'ui://tutor-desk/week.html', name: 'week', description: 'Расписание по дням', html: weekView },
  today: { uri: 'ui://tutor-desk/today.html', name: 'today', description: 'Занятия на сегодня', html: todayView },
  students: {
    uri: 'ui://tutor-desk/students.html',
    name: 'students',
    description: 'Список учеников',
    html: studentsView,
  },
  student: { uri: 'ui://tutor-desk/student.html', name: 'student', description: 'Карточка ученика', html: studentView },
};

export { VIEW_MIME };
