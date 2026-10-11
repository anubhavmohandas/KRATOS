// Training calendar maths: which upcoming dates are workouts, and an .ics file for the phone's own calendar.

export type Planned = { date: string; dayIndex: number; name: string }

/** YYYY-MM-DD in local time. */
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Monday = 0 … Sunday = 6. */
export const weekday = (d: Date) => (d.getDay() + 6) % 7

/**
 * Workouts on the chosen weekdays for `days` days from `from`, plan days in rotation starting at `next`.
 * Today is skipped once a workout is done today.
 */
export function planned(from: Date, days: number, weekdays: number[], plan: { name: string }[], next: number, doneToday: boolean): Planned[] {
  const out: Planned[] = []
  if (!plan.length) return out
  for (let i = 0, k = next; i < days; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i)
    if (!weekdays.includes(weekday(d)) || (i === 0 && doneToday)) continue
    out.push({ date: ymd(d), dayIndex: k % plan.length, name: plan[k % plan.length].name })
    k++
  }
  return out
}

const esc = (t: string) => t.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n')

/** iCalendar text: timed events with a 30-minute reminder when `time` (HH:MM) is set, else all-day events. */
export function ics(items: (Planned & { minutes: number })[], time: string | null | undefined, stamp = new Date()): string {
  const utc = stamp.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//KRATOS//Training plan//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH']
  for (const p of items) {
    const day = p.date.replace(/-/g, '')
    lines.push('BEGIN:VEVENT', `UID:kratos-${day}@kratos.local`, `DTSTAMP:${utc}`, `SUMMARY:${esc(`KRATOS · ${p.name}`)}`)
    if (time) {
      // Floating local time: the event sits at this clock time wherever the phone is.
      lines.push(`DTSTART:${day}T${time.replace(':', '')}00`, `DURATION:PT${p.minutes}M`,
        'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Workout in 30 minutes', 'TRIGGER:-PT30M', 'END:VALARM')
    } else {
      const [y, m, d] = p.date.split('-').map(Number)
      lines.push(`DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${ymd(new Date(y, m - 1, d + 1)).replace(/-/g, '')}`)
    }
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return `${lines.join('\r\n')}\r\n`
}
