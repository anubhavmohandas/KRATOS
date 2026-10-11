import { useState, type FormEvent } from 'react'
import { api, today, useApi } from '../api'
import { Alert, Button, Card, Chip, Field, Spinner } from '../ui'
import { Link } from '../router'
import { LineChart } from './Progress'

export type Checkin = { day: string; sleep_h: number; soreness: number; energy: number; stress: number; note?: string; score: number; advice: string }

const SCALES = [
  ['energy', 'Energy', ['Drained', 'Low', 'OK', 'Good', 'Great']],
  ['soreness', 'Soreness', ['None', 'Slight', 'Some', 'Sore', 'Very sore']],
  ['stress', 'Stress', ['Calm', 'Low', 'Some', 'High', 'Very high']],
] as const

const daysAgo = (n: number) => today(new Date(Date.now() - n * 864e5))

/** Today's check-in (null until answered) and a way to refresh it. */
export function useTodayCheckin() {
  const r = useApi<Checkin[]>(`/checkins?since=${today()}`)
  return { ...r, checkin: r.data?.find((c) => c.day === today()) ?? null }
}

/** Readiness as a number with its advice: the advice text carries the meaning, the colour only repeats it. */
export function Readiness({ c }: { c: Checkin }) {
  const tone = c.score >= 70 ? 'text-sage' : c.score >= 45 ? 'text-accent' : 'text-ember'
  return (
    <div className="flex items-start gap-4">
      <div className="text-center">
        <div className={`font-mono text-4xl font-bold tabular-nums ${tone}`}>{c.score}</div>
        <div className="text-[11px] uppercase tracking-wider text-ash">readiness</div>
      </div>
      <p className="flex-1 text-sm">{c.advice}</p>
    </div>
  )
}

/** In a workout: today's advice when readiness is below "ready". */
export function ReadinessNote() {
  const { checkin } = useTodayCheckin()
  return checkin && checkin.score < 70 ? <div className="mb-4"><Alert>Readiness {checkin.score} today. {checkin.advice}</Alert></div> : null
}

/** Dashboard card: ask once a day, then show the score. */
export function ReadinessCard() {
  const t = useTodayCheckin()
  const [editing, setEditing] = useState(false)
  if (t.loading) return null
  return (
    <Card title="Readiness" action={<Link href="/body/recovery" className="text-xs font-semibold text-accent hover:underline">Recovery →</Link>}>
      {t.checkin && !editing ? (
        <>
          <Readiness c={t.checkin} />
          <button className="mt-3 text-xs text-ash underline hover:text-bone" onClick={() => setEditing(true)}>Update today’s answers</button>
        </>
      ) : (
        <>
          <p className="mb-3 text-sm text-ash">How are you today? Four quick answers shape the advice for today’s workout.</p>
          <CheckinForm compact initial={t.checkin} onSaved={(c) => { t.setData([c]); setEditing(false) }} />
        </>
      )}
    </Card>
  )
}

export function CheckinForm({ initial, onSaved, compact = false }: { initial?: Checkin | null; onSaved: (c: Checkin) => void; compact?: boolean }) {
  const [f, setF] = useState({ sleep_h: String(initial?.sleep_h ?? 7.5), soreness: initial?.soreness ?? 2, energy: initial?.energy ?? 3, stress: initial?.stress ?? 2, note: initial?.note ?? '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      onSaved(await api.send<Checkin>(`/checkins/${today()}`, 'PUT', { sleep_h: +f.sleep_h, soreness: f.soreness, energy: f.energy, stress: f.stress, note: f.note.trim() || undefined }))
    } catch (x) {
      setErr((x as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Sleep last night (hours)"><input type="number" min={0} max={16} step={0.5} required value={f.sleep_h} onChange={(e) => setF({ ...f, sleep_h: e.target.value })} /></Field>
      {SCALES.map(([k, label, words]) => (
        <fieldset key={k}>
          <legend className="mb-1.5 text-xs font-medium text-ash">{label}</legend>
          <div className="flex flex-wrap gap-1.5">{words.map((w, i) => <Chip key={w} on={f[k] === i + 1} onClick={() => setF({ ...f, [k]: i + 1 })}>{w}</Chip>)}</div>
        </fieldset>
      ))}
      {!compact && <Field label="Note (optional)"><textarea rows={2} maxLength={280} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>}
      {err && <Alert tone="error">{err}</Alert>}
      <Button busy={busy}>{initial ? 'Update check-in' : 'Save check-in'}</Button>
    </form>
  )
}

export default function Recovery() {
  const since = daysAgo(27)
  const hist = useApi<Checkin[]>(`/checkins?since=${since}`)
  if (hist.loading) return <Spinner />
  const list = hist.data ?? []
  const mine = list.find((c) => c.day === today())
  const day = (d: string) => new Date(`${d}T12:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1.3fr]">
      <Card title="Today’s check-in">
        {mine && <div className="mb-5"><Readiness c={mine} /></div>}
        <CheckinForm key={mine?.day ?? 'new'} initial={mine} onSaved={() => hist.reload()} />
        <p className="mt-3 text-[11px] text-ash/80">Readiness is a nudge from your own answers (sleep, energy, soreness, stress), not a measurement. Pain or illness beats any score: rest.</p>
      </Card>
      <Card title="Readiness, last 4 weeks">
        {list.length < 2 ? <p className="text-sm text-ash">Check in on a few days and your trend appears here.</p>
          : <LineChart title="Readiness" points={list.map((c) => ({ date: `${c.day}T12:00`, v: c.score }))} unit="" />}
        {list.length > 0 && (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ash"><tr><th className="py-1.5 pr-3 font-medium">Day</th><th className="pr-3 font-medium">Score</th><th className="pr-3 font-medium">Sleep</th><th className="font-medium">Note</th></tr></thead>
              <tbody className="divide-y divide-iron-800">
                {[...list].reverse().map((c) => (
                  <tr key={c.day}><td className="py-1.5 pr-3 whitespace-nowrap">{day(c.day)}</td><td className="pr-3 font-mono">{c.score}</td><td className="pr-3 font-mono">{c.sleep_h} h</td><td className="text-ash">{c.note}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
