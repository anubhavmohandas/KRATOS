import type { ReactNode } from 'react'
import { estMinutes, fmtLoad, fmtTarget, fromKg, local, NEXT_DAY_KEY, SESSION_KEY, useApi, useCatalog, type ActiveSession, type Plan, type Profile } from '../api'
import { Cover, useMusic } from '../music/Music'
import { TimerPanel, useTimer } from '../timer/Timer'
import { Button, Card, LinkButton } from '../ui'
import type { ProgressData } from './Progress'
import { Link } from '../router'

const greeting = () => { const h = new Date().getHours(); return h < 5 ? 'Late session' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening' }

function Tile({ label, value, sub, href }: { label: string; value: ReactNode; sub: string; href: string }) {
  return (
    <Link href={href} className="group rounded-xl border border-iron-700 bg-iron-900 p-4 transition-colors hover:border-iron-600">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ash">{label}</div>
      <div className="mt-2 truncate font-display text-3xl font-bold uppercase group-hover:text-accent">{value}</div>
      <div className="truncate text-xs text-ash">{sub}</div>
    </Link>
  )
}

export default function Dashboard({ profile }: { profile: Profile }) {
  const plan = useApi<Plan>('/plans/active')
  const prog = useApi<ProgressData>('/progress')
  const catalog = useCatalog()
  const music = useMusic()
  const timer = useTimer()
  const active = local.get<ActiveSession>(SESSION_KEY)
  const p = plan.data
  const resuming = !!(active && p && active.plan_id === p.id)
  const di = resuming ? active!.day : Math.min(local.get<number>(NEXT_DAY_KEY) ?? 0, (p?.days.length ?? 1) - 1)
  const d = p?.days[di]
  const week = prog.data?.sessions.filter((s) => Date.parse(s.started_at) > Date.now() - 7 * 864e5).length ?? 0
  const u = profile.units

  return (
    <>
      <div className="mb-6">
        <p className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-accent">Personal fitness intelligence</p>
        <h1 className="font-display text-3xl font-bold uppercase tracking-wide sm:text-4xl">{greeting()}</h1>
        <p className="text-sm text-ash">{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile href="/train" label="Today’s workout" value={d ? `Day ${String(di + 1).padStart(2, '0')}` : '—'} sub={d?.name ?? 'No plan yet'} />
        <Tile href="/train" label="Planned duration" value={d ? `${estMinutes(d)} min` : '—'} sub={d ? `${d.items.length} exercises` : 'Generate a plan'} />
        <Tile href="/progress" label="This week" value={`${week}/${profile.days_per_week}`} sub={`${prog.data?.sessions.length ?? 0} workouts total`} />
        <Link href="/space/music" className="group flex items-center gap-3 rounded-xl border border-iron-700 bg-iron-900 p-4 transition-colors hover:border-iron-600">
          <Cover name={music.current?.name} className="size-14 shrink-0" />
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ash">Music</div>
            <div className="truncate font-medium group-hover:text-accent">{music.current?.name ?? 'Your training soundtrack'}</div>
            <div className="text-xs text-ash">{music.current ? (music.playing ? 'Playing' : 'Paused') : `${music.tracks.length} tracks`}</div>
          </div>
        </Link>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card title={resuming ? 'Workout in progress' : 'Continue your training'} action={<LinkButton href="/train">{resuming ? 'Resume' : d ? `Start ${d.name}` : 'Build a plan'}</LinkButton>}>
          {!d ? <p className="text-sm text-ash">Generate a plan from your profile and equipment, or import one from a PDF.</p> : (
            <ol className="divide-y divide-iron-800">
              {d.items.map((it, i) => (
                <li key={it.exercise_id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="font-mono text-xs text-ash">{String(i + 1).padStart(2, '0')}</span>
                  <span className="min-w-0 flex-1 truncate">{catalog[it.exercise_id]?.name ?? it.exercise_id}</span>
                  <span className="font-mono text-xs text-ash">{fmtTarget(it)}</span>
                  {it.rx?.load_kg != null && <span className="font-mono text-xs text-accent">{fmtLoad(it.rx.load_kg, u)}</span>}
                </li>
              ))}
            </ol>
          )}
        </Card>

        <div className="space-y-5">
          {timer.run ? <TimerPanel /> : (
            <Card title="Timers">
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => timer.start({ kind: 'countdown', seconds: 90, label: 'Rest' })}>Rest 90s</Button>
                <Button variant="ghost" onClick={() => timer.start({ kind: 'intervals', work: 20, rest: 10, rounds: 8, prepare: 10, label: 'Tabata' })}>Tabata</Button>
                <Button variant="ghost" onClick={() => timer.start({ kind: 'stopwatch', label: 'Stopwatch' })}>Stopwatch</Button>
                <Link href="/space/timers" className="self-center text-xs font-semibold text-accent hover:underline">More →</Link>
              </div>
            </Card>
          )}
          <Card title="Records" action={<Link href="/progress" className="text-xs font-semibold text-accent hover:underline">Progress →</Link>}>
            {!prog.data?.records.length ? <p className="text-sm text-ash">Log sets to start setting records.</p> : (
              <ul className="space-y-2 text-sm">
                {[...prog.data.records].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4).map((r) => (
                  <li key={r.exercise_id + r.kind} className="flex justify-between gap-3">
                    <span className="truncate">{r.name}</span>
                    <span className="font-mono text-ash">{r.kind === 'e1rm' ? `${fromKg(r.value, u)} ${u} e1RM` : `${r.value} ${r.kind === 'sec' ? 's' : 'reps'}`}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Body" action={<Link href="/body" className="text-xs font-semibold text-accent hover:underline">Body Lab →</Link>}>
            <div className="font-mono text-2xl font-bold">{fromKg(prog.data?.weights.at(-1)?.kg ?? profile.weight_kg, u)} <span className="text-sm text-ash">{u}</span></div>
            <p className="text-xs text-ash">{prog.data?.weights.length ? `Last weigh-in ${new Date(prog.data.weights.at(-1)!.date).toLocaleDateString()}` : 'From your profile — log weigh-ins in Body Lab'}</p>
          </Card>
        </div>
      </div>
    </>
  )
}
