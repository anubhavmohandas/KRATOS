import { useEffect, useRef, useState, type ReactNode } from 'react'
import { fromKg, useApi, type Profile, type Units } from '../api'
import { Alert, Card, PageHead, Spinner, Stat } from '../ui'
import { Link } from '../router'

type Pt = { date: string; v: number }
export type ProgressData = {
  records: { exercise_id: string; name: string; kind: 'e1rm' | 'reps' | 'sec'; value: number; date: string }[]
  weights: { date: string; kg: number }[]
  lifts: { exercise_id: string; name: string; points: { date: string; e1rm: number }[] }[]
  sessions: { id: number; started_at: string; completed_at: string }[]
  totals: { sets: number; volume_kg: number }
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export default function Progress({ profile }: { profile: Profile }) {
  const { data, error, loading } = useApi<ProgressData>('/progress')
  const [lift, setLift] = useState('')
  if (loading) return <Spinner />
  if (error || !data) return <Alert tone="error">{error?.message}</Alert>

  const u = profile.units
  const sel = data.lifts.find((l) => l.exercise_id === lift) ?? data.lifts[0]
  const weeks = Array.from({ length: 8 }, (_, i) => {
    const end = Date.now() - i * 7 * 864e5
    return { label: i === 0 ? 'This wk' : `${i}w ago`, n: data.sessions.filter((s) => { const t = Date.parse(s.started_at); return t <= end && t > end - 7 * 864e5 }).length }
  }).reverse()
  const maxWeek = Math.max(profile.days_per_week, ...weeks.map((w) => w.n))

  return (
    <>
      <PageHead kicker="Progress" title="The long game" />
      <div className="mb-5 grid grid-cols-2 gap-4 rounded-xl border border-iron-700 bg-iron-900 p-5 sm:grid-cols-4">
        <Stat label="Workouts" value={data.sessions.length} />
        <Stat label="Sets logged" value={data.totals.sets} />
        <Stat label="Volume lifted" value={Math.round(fromKg(data.totals.volume_kg, u)).toLocaleString()} unit={u} />
        <Stat label="Body weight" value={data.weights.length ? fromKg(data.weights.at(-1)!.kg, u) : fromKg(profile.weight_kg, u)} unit={u} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Estimated 1-rep max" action={data.lifts.length > 1 && (
          <select aria-label="Exercise" className="!w-auto !py-1 text-sm" value={sel?.exercise_id} onChange={(e) => setLift(e.target.value)}>
            {data.lifts.map((l) => <option key={l.exercise_id} value={l.exercise_id}>{l.name}</option>)}
          </select>
        )}>
          {sel ? <LineChart title={sel.name} points={sel.points.map((p) => ({ date: p.date, v: fromKg(p.e1rm, u) }))} unit={u} />
            : <Empty>Log a few weighted sets and your strength trend appears here.</Empty>}
        </Card>
        <Card title="Body weight">
          {data.weights.length ? <LineChart title="Body weight" points={data.weights.map((w) => ({ date: w.date, v: fromKg(w.kg, u) }))} unit={u} />
            : <Empty>Add weigh-ins in <Link className="text-accent hover:underline" href="/body">Body Lab</Link>. Scale weight alone doesn’t prove muscle gain or fat loss.</Empty>}
        </Card>
      </div>

      <Card title="Personal records" className="mt-5">
        {!data.records.length ? <p className="text-sm text-ash">Records appear as you log sets.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ash"><tr><th className="pb-2 font-medium">Exercise</th><th className="font-medium">Best</th><th className="text-right font-medium">Date</th></tr></thead>
              <tbody className="divide-y divide-iron-800">
                {data.records.map((r) => (
                  <tr key={r.exercise_id + r.kind}>
                    <td className="py-2 pr-4">{r.name}</td>
                    <td className="pr-4 font-mono">{r.kind === 'e1rm' ? <>{fromKg(r.value, u)} {u} <span className="text-xs text-ash">est. 1RM</span></> : `${r.value} ${r.kind === 'sec' ? 's hold' : 'reps'}`}</td>
                    <td className="text-right font-mono text-xs text-ash">{day(r.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Consistency — workouts per week" className="mt-5">
        <div className="flex h-36 items-end gap-2" role="list">
          {weeks.map((w) => (
            <div key={w.label} role="listitem" className="group flex flex-1 flex-col items-center gap-1.5" title={`${w.label}: ${w.n} workout${w.n === 1 ? '' : 's'}`}>
              <span className="font-mono text-xs text-ash group-hover:text-bone">{w.n || ''}</span>
              <div className="w-full max-w-10 rounded-t bg-accent/80 transition-colors group-hover:bg-accent" style={{ height: `${(w.n / maxWeek) * 96}px`, minHeight: w.n ? 4 : 0 }} />
              <div className="h-px w-full bg-iron-700" />
              <span className="text-[10px] whitespace-nowrap text-ash">{w.label}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-ash">Target: {profile.days_per_week} per week.</p>
      </Card>
    </>
  )
}

const Empty = ({ children }: { children: ReactNode }) => <p className="grid h-48 place-items-center px-6 text-center text-sm text-ash">{children}</p>

/** Single-series line: 2px stroke, ≥8px markers, crosshair + tooltip, table view for screen readers. */
function LineChart({ title, points, unit }: { title: string; points: Pt[]; unit: Units }) {
  const [hover, setHover] = useState<number | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(600) // real pixel width, so axis text stays 11px on phones
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(260, Math.round(e.contentRect.width))))
    ro.observe(box.current!)
    return () => ro.disconnect()
  }, [])
  const H = 220, L = 44, R = 12, T = 12, B = 28
  const vs = points.map((p) => p.v)
  const pad = Math.max(1, (Math.max(...vs) - Math.min(...vs)) * 0.15)
  const lo = Math.floor(Math.min(...vs) - pad), hi = Math.ceil(Math.max(...vs) + pad)
  const x = (i: number) => (points.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (points.length - 1))
  const y = (v: number) => T + ((hi - v) * (H - T - B)) / (hi - lo || 1)
  const ticks = [lo, (lo + hi) / 2, hi]
  const h = hover !== null ? points[hover] : null

  return (
    <figure>
      <div ref={box} className="relative">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block touch-none select-none" aria-hidden
          onPointerLeave={() => setHover(null)}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            const px = ((e.clientX - r.left) / r.width) * W
            setHover(points.length === 1 ? 0 : Math.max(0, Math.min(points.length - 1, Math.round(((px - L) / (W - L - R)) * (points.length - 1)))))
          }}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--color-iron-800)" />
              <text x={L - 8} y={y(t) + 4} textAnchor="end" className="fill-ash font-mono text-[11px]">{Math.round(t)}</text>
            </g>
          ))}
          <text x={L} y={H - 6} className="fill-ash text-[11px]">{day(points[0].date)}</text>
          {points.length > 1 && <text x={W - R} y={H - 6} textAnchor="end" className="fill-ash text-[11px]">{day(points.at(-1)!.date)}</text>}
          <polyline fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" points={points.map((p, i) => `${x(i)},${y(p.v)}`).join(' ')} />
          {h && <line x1={x(hover!)} x2={x(hover!)} y1={T} y2={H - B} stroke="var(--color-iron-600)" strokeDasharray="3 3" />}
          {points.map((p, i) => <circle key={i} cx={x(i)} cy={y(p.v)} r={i === hover ? 6 : 4} fill="var(--color-iron-900)" stroke="var(--color-accent)" strokeWidth={2} />)}
          <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" />
        </svg>
        {h && (
          <div className="pointer-events-none absolute top-0 rounded-md border border-iron-700 bg-iron-950 px-2.5 py-1.5 text-xs shadow-lg"
            style={{ left: `${(x(hover!) / W) * 100}%`, transform: `translateX(${hover! > points.length / 2 ? '-105%' : '5%'})` }}>
            <div className="text-ash">{day(h.date)}</div>
            <div className="font-mono font-bold text-bone">{h.v} {unit}</div>
          </div>
        )}
      </div>
      <details className="mt-2 text-xs text-ash">
        <summary className="cursor-pointer hover:text-bone">Table view</summary>
        <table className="mt-2 w-full font-mono">
          <caption className="sr-only">{title}</caption>
          <thead><tr><th className="text-left font-medium">Date</th><th className="text-right font-medium">{unit}</th></tr></thead>
          <tbody>{points.map((p, i) => <tr key={i}><td>{day(p.date)}</td><td className="text-right text-bone">{p.v}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  )
}
