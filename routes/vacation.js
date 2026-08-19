const express = require('express');

const router = express.Router();

// Единственное место в приложении, которое обращается к внешнему сервису из
// самой фичи (не из авто-обновления) — isdayoff.ru, открытый бесплатный
// производственный календарь РФ, без ключа. Наружу уходит только диапазон
// дат, никаких сумм и другой личной информации (см. README «Безопасность»).
const ISDAYOFF_BASE = 'https://isdayoff.ru/api/getdata';
const AVERAGE_MONTH_DAYS = 29.3; // фиксированный коэффициент, Постановление Правительства №922

function isValidDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

function daysInMonth(year, month) { // month: 1-12
  return new Date(year, month, 0).getDate();
}

// «Числа выплат» из формы (например, 5 и 20) не привязаны к конкретному
// месяцу — clamp на случай payday=31 в 30-дневном или более коротком месяце,
// тот же приём, что и у повторяющихся операций (routes/recurring.js).
function paydayDate(year, month, day) {
  const clamped = Math.min(day, daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

// Выплата в первой половине месяца (1–15) закрывает первую половину ЭТОГО же
// месяца; выплата во второй половине (16–31) закрывает вторую половину
// ПРЕДЫДУЩЕГО месяца — так почти везде на практике (аванс/зарплата), это не
// жёсткая норма ТК РФ (там только «не реже чем каждые полмесяца»), а
// осознанное упрощение, подтверждённое с пользователем.
function periodForPayday(year, month, day) {
  if (day <= 15) {
    let pm = month - 1;
    let py = year;
    if (pm === 0) { pm = 12; py -= 1; }
    return { from: `${py}-${String(pm).padStart(2, '0')}-16`, to: `${py}-${String(pm).padStart(2, '0')}-${String(daysInMonth(py, pm)).padStart(2, '0')}` };
  }
  return { from: `${year}-${String(month).padStart(2, '0')}-01`, to: `${year}-${String(month).padStart(2, '0')}-15` };
}

// Диапазон для загрузки календаря — с запасом назад (переносы выплат при
// длинных праздничных блоках, например новогодних, могут откатываться на
// полторы-две недели) и вперёд.
//
// Запас вперёд не может быть маленьким: nextPaydayOnOrAfter() ниже может
// уйти в следующий месяц относительно даты отпускных (если "число выплаты"
// в текущем месяце уже прошло к моменту выплаты отпускных), а
// periodForPayday() для найденной даты может охватывать ещё и половину ЕЁ
// месяца — то есть календарь может понадобиться почти на 2 месяца позже
// vacationStart. Раньше здесь было +5 дней от vacationEnd — этого не хватало
// (найдено на реальном примере: короткий отпуск в начале месяца + число
// выплаты в середине месяца — обе выплаты молча схлопывались в одну
// неверную дату, потому что rollBackToWorkingDay() шёл в календарь, где
// нужных дат просто не было, читал undefined как «не рабочий день» и уезжал
// откатом далеко назад). +60 дней от vacationEnd — с запасом на этот случай.
function calendarFetchRange(vacationStart, vacationEnd) {
  return { from: addDays(vacationStart, -45), to: addDays(vacationEnd, 60) };
}

// calendar: { 'YYYY-MM-DD': '0'|'1'|'8'|... } — '0' рабочий, '1' обычный
// выходной, '8' праздник (см. fetchCalendar/fallbackCalendar ниже).
function isWorkingDay(calendar, date) {
  return calendar[date] === '0';
}
function isHoliday(calendar, date) {
  return calendar[date] === '8';
}

function countDays(from, to, predicate) {
  if (from > to) return 0;
  let count = 0;
  let d = from;
  while (d <= to) {
    if (predicate(d)) count++;
    d = addDays(d, 1);
  }
  return count;
}

// «Не позднее» (ст. 136 ТК РФ) — если расчётная дата выплаты попадает на
// нерабочий день, платить нужно РАНЬШЕ, не позже (Письмо Роструда от
// 30.07.2014 № 1693-6-1) — откатываем назад до ближайшего рабочего дня.
// Действует одинаково и для отпускных, и для обычной зарплаты/аванса.
function rollBackToWorkingDay(dateStr, calendar) {
  let d = dateStr;
  let guard = 0;
  while (!isWorkingDay(calendar, d) && guard < 30) {
    d = addDays(d, -1);
    guard++;
  }
  return d;
}

// Ближайшее число `day` (с учётом clamp) НЕ РАНЬШЕ `afterDate» — а не
// «то же число в месяце начала отпуска». Раньше оба payday считались в
// месяце vacationStart, из-за чего для отпуска, начинающегося ближе к концу
// месяца, могла попасть выплата, которая на самом деле УЖЕ прошла к моменту
// выплаты отпускных (например: отпускные 16 октября, а «выплата 5 октября»
// в эту дату давно позади — реально следующая после 16-го — 5 ноября).
// Найдено пользователем на реальном примере, воспроизведено и исправлено.
function nextPaydayOnOrAfter(day, afterDate) {
  let [y, m] = afterDate.split('-').map(Number);
  for (let i = 0; i < 24; i++) {
    const candidate = paydayDate(y, m, day);
    if (candidate >= afterDate) return { year: y, month: m, date: candidate };
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  throw new Error('could not resolve next payday date'); // недостижимо при разумных входных данных — просто защита от бесконечного цикла
}

// Чистая функция расчёта — без сети, поэтому легко тестируется на заранее
// подготовленном календаре (см. test/server.test.js). Роут ниже отвечает
// только за загрузку календаря и вызывает её.
function calculateVacation({ salary, salaryIsGross, vacationStart, vacationEnd, payday1, payday2 }, calendar) {
  const netSalary = salaryIsGross ? salary * 0.87 : salary;

  const rawVacationPayDate = addDays(vacationStart, -3);
  const vacationPayDate = rollBackToWorkingDay(rawVacationPayDate, calendar);
  const totalVacationDays = countDays(vacationStart, vacationEnd, () => true);
  const holidaysExcluded = countDays(vacationStart, vacationEnd, (d) => isHoliday(calendar, d));
  const paidVacationDays = totalVacationDays - holidaysExcluded;
  const avgDailyPay = netSalary / AVERAGE_MONTH_DAYS;
  const vacationPay = avgDailyPay * paidVacationDays;

  const payments = [payday1, payday2].map((day) => {
    const { year: y, month: m, date: rawDate } = nextPaydayOnOrAfter(day, vacationPayDate);
    const date = rollBackToWorkingDay(rawDate, calendar);
    const period = periodForPayday(y, m, day);
    const workingDaysInPeriod = countDays(period.from, period.to, (d) => isWorkingDay(calendar, d));
    const overlapFrom = period.from > vacationStart ? period.from : vacationStart;
    const overlapTo = period.to < vacationEnd ? period.to : vacationEnd;
    const workingDaysOnVacation = countDays(overlapFrom, overlapTo, (d) => isWorkingDay(calendar, d));
    const workedDays = workingDaysInPeriod - workingDaysOnVacation;
    const amount = workingDaysInPeriod > 0 ? (netSalary / 2) * (workedDays / workingDaysInPeriod) : 0;
    return { day, date, period, workingDaysInPeriod, workedDays, amount };
  }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    netSalary,
    vacationPay: { date: vacationPayDate, amount: vacationPay, totalDays: totalVacationDays, paidDays: paidVacationDays, holidaysExcluded },
    payments,
  };
}

// Разобрана отдельно от fetchCalendar() ниже, чтобы саму проверку можно было
// протестировать офлайн (см. test/server.test.js) — без неё пришлось бы
// мокать сеть, чтобы воспроизвести Bug 2.
//
// isdayoff.ru сигнализирует свои ошибки (неверный диапазон и т.п.) КОРОТКИМИ
// числовыми кодами вроде "100"/"101"/"199" — они бы прошли простую проверку
// «строка из цифр», но это не день-в-день календарь, а код ошибки. Без
// проверки длины часть дат осталась бы без записи в calendar (undefined),
// что isWorkingDay() тихо трактует как «не рабочий день» — та же порча
// данных, что и слишком узкий calendarFetchRange (см. выше), только из-за
// ответа API, а не диапазона запроса. Раз длина не совпадает, это не
// валидный календарь — уходим на fallback, а не рискуем половиной данных.
function parseCalendarResponse(text, from, to) {
  const trimmed = text.trim();
  const expectedDays = countDays(from, to, () => true);
  if (!/^[0-9]+$/.test(trimmed) || trimmed.length !== expectedDays) {
    throw new Error('unexpected isdayoff.ru response');
  }
  const calendar = {};
  let d = from;
  for (let i = 0; i < trimmed.length; i++) {
    calendar[d] = trimmed[i];
    d = addDays(d, 1);
  }
  return calendar;
}

async function fetchCalendar(from, to) {
  const url = `${ISDAYOFF_BASE}?date1=${from.replace(/-/g, '')}&date2=${to.replace(/-/g, '')}&cc=ru&holiday=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`isdayoff.ru responded with ${res.status}`);
  const text = await res.text();
  return parseCalendarResponse(text, from, to);
}

// Календарь недоступен (нет сети, сервис лёг) — деградируем до «только
// обычные выходные по дням недели», без праздников, вместо падения всей
// фичи. Фронтенд явно предупреждает об этом (calendarAvailable: false).
function fallbackCalendar(from, to) {
  const calendar = {};
  let d = from;
  while (d <= to) {
    const dow = new Date(`${d}T00:00:00`).getDay(); // 0=вс, 6=сб
    calendar[d] = (dow === 0 || dow === 6) ? '1' : '0';
    d = addDays(d, 1);
  }
  return calendar;
}

router.post('/calculate', async (req, res) => {
  const { salary, salaryIsGross, vacationStart, vacationEnd, payday1, payday2 } = req.body;

  if (!(Number(salary) > 0)) {
    return res.status(400).json({ error: 'Укажите оклад больше нуля' });
  }
  if (!isValidDate(vacationStart) || !isValidDate(vacationEnd) || vacationEnd < vacationStart) {
    return res.status(400).json({ error: 'Укажите корректные даты отпуска — окончание не раньше начала' });
  }
  const p1 = Number(payday1);
  const p2 = Number(payday2);
  if (!Number.isInteger(p1) || p1 < 1 || p1 > 31 || !Number.isInteger(p2) || p2 < 1 || p2 > 31) {
    return res.status(400).json({ error: 'Числа выплат должны быть целыми от 1 до 31' });
  }

  // Целиком в try/catch, а не только вокруг fetchCalendar — этот роут async,
  // и Express 4 не ловит отклонённый promise async-хендлера сам (см.
  // routes/export.js и CLAUDE.md «Чек-лист для нового роута» — необработанный
  // reject здесь уронил бы весь процесс, а не только этот запрос).
  try {
    const { from, to } = calendarFetchRange(vacationStart, vacationEnd);
    let calendar;
    let calendarAvailable = true;
    try {
      calendar = await fetchCalendar(from, to);
    } catch (e) {
      console.error('[vacation] isdayoff.ru unavailable, falling back to weekends-only:', e.message);
      calendarAvailable = false;
      calendar = fallbackCalendar(from, to);
    }

    const result = calculateVacation(
      { salary: Number(salary), salaryIsGross: !!salaryIsGross, vacationStart, vacationEnd, payday1: p1, payday2: p2 },
      calendar
    );
    res.json({ ...result, calendarAvailable });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка при расчёте отпускных: ' + e.message });
  }
});

module.exports = router;
module.exports.calculateVacation = calculateVacation;
module.exports.fallbackCalendar = fallbackCalendar;
module.exports.calendarFetchRange = calendarFetchRange;
module.exports.parseCalendarResponse = parseCalendarResponse;
