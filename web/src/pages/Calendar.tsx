import { useState, type FormEvent } from 'react'
import { api, estMinutes, local, NEXT_DAY_KEY, useApi, type Plan, type Profile } from '../api'
import { ics, planned, weekday, ymd } from '../calendar'
import { Alert, Button, Card, Chip, Field, Spinner } from '../ui'
import type { ProgressData } from './Progress'

const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default function Calendar({ profile, onProfile }: { profile: Profile; onProfile: (p: Profile) => void }) {
  const plan = useApi<Plan>('/plans/active')
  const prog = useApi<ProgressData>('/progress')
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const [days, setDays] = useState<number[]>(profile.weekdays ?? [])
  const [time, setTime] = useState(profile.train_time ?? '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  if (plan.loading || prog.loading) return <Spinner />
  const p = plan.data
  const sessions = prog.data?.sessions ?? []
  const done = new Map<string, typeof sessions>()
  for (const s of sessions) {
    const k = ymd(new Date(s.started_at))
    done.set(k, [...(done.get(k) ?? []), s])
  }
  const now = new Date()
  const last = sessions.at(-1)
  // Next plan day: the one after your last finished workout (any device), else this browser's guess.
  const next = last ? last.day_index + 1 : local.get<number>(NEXT_DAY_KEY) ?? 0
  const upcoming = (n: number) => (p ? planned(now, n, profile.weekdays ?? [], p.days, next, done.has(ymd(now))) : [])
  const plannedOn = new Map(upcoming(400).map((x) => [x.date, x]))

  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - weekday(first))
  const weeks = Math.ceil((weekday(first) + new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()) / 7)
  const cells = Array.from({ length: weeks * 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      onProfile(await api.send<Profile>('/profile', 'PUT', { ...profile, weekdays: days, train_time: time || null }))
      setMsg({ tone: 'ok', text: 'Schedule saved.' })
    } catch (x) {
      setMsg({ tone: 'error', text: (x as Error).message })
    } finally {
      setBusy(false)
    }
  }

  function download() {
    const items = upcoming(28).map((x) => ({ ...x, minutes: estMinutes(p!.days[x.dayIndex]) }))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([ics(items, profile.train_time)], { type: 'text/calendar' }))
    a.download = 'kratos-workouts.ics'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1))
  const title = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_20rem]">
      <Card title={title} action={
        <div className="flex gap-1">
          <Button variant="ghost" className="!px-3 !py-1" aria-label="Previous month" onClick={() => shift(-1)}>‹</Button>
          <Button variant="ghost" className="!px-3 !py-1" aria-label="Next month" onClick={() => shift(1)}>›</Button>
        </div>
      }>
        <table className="w-full table-fixed text-xs">
          <caption className="sr-only">Workouts in {title}</caption>
          <thead><tr>{WD.map((d) => <th key={d} className="pb-2 font-medium text-ash">{d}</th>)}</tr></thead>
          <tbody>
            {Array.from({ length: weeks }, (_, w) => (
              <tr key={w}>
                {cells.slice(w * 7, w * 7 + 7).map((d) => {
                  const k = ymd(d)
                  const inMonth = d.getMonth() === month.getMonth()
                  const plan_ = plannedOn.get(k)
                  return (
                    <td key={k} className={`h-16 border border-iron-800 p-1 align-top sm:h-20 ${inMonth ? '' : 'opacity-40'}`}>
                      <div className={`mb-0.5 font-mono ${k === ymd(now) ? 'inline-block rounded bg-accent px-1 font-bold text-iron-950' : 'text-ash'}`}>{d.getDate()}</div>
                      {done.get(k)?.map((s) => <div key={s.id} className="truncate rounded bg-sage/15 px-1 text-sage" title={`${s.day}: ${s.sets} sets`}>✓ {s.day}</div>)}
                      {plan_ && <div className="truncate rounded border border-accent/50 px-1 text-accent-hi" title={`Planned: ${plan_.name}`}>{plan_.name}</div>}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-ash"><span className="text-sage">✓ done</span> · <span className="text-accent-hi">outlined = planned</span>, plan days in order from your last workout.</p>
      </Card>

      <div className="space-y-5">
        <Card title="Schedule">
          <form onSubmit={save} className="space-y-4">
            <fieldset>
              <legend className="mb-1.5 text-xs font-medium text-ash">Training days</legend>
              <div className="flex flex-wrap gap-1.5">
                {WD.map((d, i) => <Chip key={d} on={days.includes(i)} onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort())}>{d}</Chip>)}
              </div>
              {days.length > 0 && days.length !== profile.days_per_week && <p className="mt-1.5 text-xs text-ash">Your profile says {profile.days_per_week} a week; you picked {days.length}.</p>}
            </fieldset>
            <Field label="Usual time (optional)" hint="Adds a reminder 30 minutes before in your phone’s calendar."><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
            {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
            <Button busy={busy}>Save schedule</Button>
          </form>
        </Card>
        <Card title="Phone calendar">
          <p className="mb-3 text-sm text-ash">The next 4 weeks of workouts as a calendar file. Open it on your phone to add them; download again after changing your plan or days.</p>
          <Button variant="ghost" disabled={!p || !(profile.weekdays ?? []).length} onClick={download}>Add next 4 weeks to my calendar</Button>
          {!p && <p className="mt-2 text-xs text-ash">Generate a plan first.</p>}
        </Card>
      </div>
    </div>
  )
}
