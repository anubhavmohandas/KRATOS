import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ics, planned, weekday, ymd } from './calendar.ts'

const plan = [{ name: 'Push' }, { name: 'Pull' }, { name: 'Legs' }]
const mon = new Date(2026, 9, 12) // Monday 12 Oct 2026

test('weekday counts from Monday', () => {
  assert.equal(weekday(mon), 0)
  assert.equal(weekday(new Date(2026, 9, 18)), 6)
})

test('planned dates follow the weekdays and rotate the plan', () => {
  const p = planned(mon, 14, [0, 2, 4], plan, 1, false)
  assert.deepEqual(p.map((x) => x.date), ['2026-10-12', '2026-10-14', '2026-10-16', '2026-10-19', '2026-10-21', '2026-10-23'])
  assert.deepEqual(p.map((x) => x.name), ['Pull', 'Legs', 'Push', 'Pull', 'Legs', 'Push'])
  assert.equal(planned(mon, 7, [0, 2], plan, 0, true)[0].date, '2026-10-14', 'done today → today is not planned again')
  assert.deepEqual(planned(mon, 7, [], plan, 0, false), [])
  assert.equal(ymd(new Date(2026, 11, 31 + 1)), '2027-01-01', 'month and year roll over')
})

test('ics: timed events with a reminder, all-day without a time, text escaped', () => {
  const items = [{ date: '2026-10-31', dayIndex: 0, name: 'Push, chest; arms', minutes: 50 }]
  const timed = ics(items, '18:30', new Date(Date.UTC(2026, 9, 11, 9, 0, 0)))
  assert.match(timed, /^BEGIN:VCALENDAR\r\n/)
  assert.match(timed, /\r\nDTSTART:20261031T183000\r\nDURATION:PT50M\r\n/)
  assert.match(timed, /\r\nTRIGGER:-PT30M\r\n/)
  assert.match(timed, /\r\nSUMMARY:KRATOS · Push\\, chest\\; arms\r\n/)
  assert.match(timed, /\r\nDTSTAMP:20261011T090000Z\r\n/)
  const allDay = ics(items, null)
  assert.match(allDay, /DTSTART;VALUE=DATE:20261031\r\nDTEND;VALUE=DATE:20261101\r\n/)
  assert.doesNotMatch(allDay, /VALARM/)
  assert.ok(allDay.endsWith('END:VCALENDAR\r\n'))
})
