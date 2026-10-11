import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, ApiError, fmtLoad, fmtTarget, fromKg, toKg, useCatalog, type Plan, type SetLog, type Units } from '../api'
import { createCounter, PROFILES, type CounterState } from '../vision/metrics'
import { Alert, Button, Card, Field, Spinner, Stat } from '../ui'
import { TimerPanel, useTimer } from '../timer/Timer'

// three.js and MediaPipe are most of the bundle: load them when a workout first needs them.
const Trainer3D = lazy(() => import('../trainer/Trainer3D'))
const PoseCamera = lazy(() => import('../vision/PoseCamera'))

type Props = { plan: Plan; dayIndex: number; sessionId: number; units: Units; onExit: (done: boolean) => void }

export default function Session({ plan, dayIndex, sessionId, units, onExit }: Props) {
  const day = plan.days[dayIndex]
  const catalog = useCatalog()
  const [idx, setIdx] = useState(0)
  const [logs, setLogs] = useState<SetLog[]>([])
  const [form, setForm] = useState({ load: '', reps: '', rir: '2' })
  const timer = useTimer()
  const [camera, setCamera] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [done, setDone] = useState<null | { sets: number; volume: number; minutes: number; next: Plan['days'][number] | null }>(null)
  const started = useRef(Date.now())

  const item = day.items[idx]
  const ex = catalog[item.exercise_id]
  const mine = logs.filter((l) => l.exercise_id === item.exercise_id)
  const timed = item.unit === 'sec'

  useEffect(() => {
    api.get<{ sets: SetLog[]; started_at: string; completed_at: string | null }>(`/sessions/${sessionId}`)
      .then((s) => {
        if (s.completed_at) return onExit(true) // finished on another device
        setLogs(s.sets)
        started.current = Date.parse(s.started_at)
        setLoaded(true)
      })
      // Gone after a delete-all or restore: leave instead of trapping you in a workout that can't save.
      .catch((e) => (e instanceof ApiError && e.status === 404 ? onExit(false) : setErr(e.message)))
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Prefill from the last set of this exercise today, else the prescription (again once a resumed workout's sets load).
  useEffect(() => {
    const last = logs.filter((l) => l.exercise_id === item.exercise_id).at(-1)
    const kg = last?.load_kg ?? item.rx?.load_kg
    setForm({ load: kg ? String(fromKg(kg, units)) : '', reps: String(last?.reps ?? item.rx?.reps ?? item.rep_max), rir: '2' })
    setCamera(false)
  }, [idx, loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  async function logSet(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const s = await api.send<SetLog>(`/sessions/${sessionId}/sets`, 'POST', {
        // max + 1, not length + 1: after undoing a middle set, length + 1 would land on (and overwrite) the last set.
        exercise_id: item.exercise_id, set_number: Math.max(0, ...mine.map((l) => l.set_number)) + 1,
        load_kg: form.load ? +toKg(+form.load, units).toFixed(3) : 0, reps: +form.reps, rir: timed ? null : +form.rir,
      })
      setLogs((l) => [...l, s])
      if (item.rest_seconds > 0) timer.start({ kind: 'countdown', seconds: item.rest_seconds, label: `Rest · ${ex?.name ?? ''}` })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function undo(id: number) {
    setErr('')
    try {
      await api.send(`/sessions/${sessionId}/sets/${id}`, 'DELETE')
      setLogs((l) => l.filter((x) => x.id !== id))
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  async function finish() {
    if (!logs.length && !confirm('No sets logged. End this workout anyway?')) return
    try {
      await api.send(`/sessions/${sessionId}/complete`, 'POST')
    } catch (e) {
      // A dialog, not the inline alert: the top Finish button is far from it on a phone.
      return alert(`Couldn’t finish the workout: ${(e as Error).message}\n\nYour sets are saved. Try again.`)
    }
    if (timer.run?.cfg.label.startsWith('Rest')) timer.stop()
    // Prescriptions recalculate from what was just logged — show them as next time's targets.
    const next = await api.get<Plan>('/plans/active').then((p) => p.days[dayIndex] ?? null, () => null)
    setDone({ sets: logs.length, volume: logs.reduce((v, l) => v + l.load_kg * l.reps, 0), minutes: Math.round((Date.now() - started.current) / 60000), next })
  }

  if (done) {
    return (
      <Card title="Workout complete" className="mx-auto max-w-xl">
        <h1 className="mb-5 font-display text-3xl font-bold uppercase">{day.name} — done</h1>
        <div className="mb-6 grid grid-cols-3 gap-4">
          <Stat label="Sets" value={done.sets} />
          <Stat label="Volume" value={Math.round(fromKg(done.volume, units))} unit={units} />
          <Stat label="Time" value={done.minutes} unit="min" />
        </div>
        {done.next && (
          <div className="mb-6">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-accent">Next {day.name} — targets from today’s sets</h2>
            <ul className="divide-y divide-iron-800 text-sm">
              {done.next.items.map((it) => (
                <li key={it.exercise_id} className="flex justify-between gap-3 py-2">
                  <span>{catalog[it.exercise_id]?.name}</span>
                  <span className="font-mono text-ash">{it.rx?.load_kg != null ? `${fmtLoad(it.rx.load_kg, units)} × ${it.rx.reps}` : fmtTarget(it)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Button onClick={() => onExit(true)}>Back to plan</Button>
      </Card>
    )
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-display text-xs font-semibold uppercase tracking-[0.2em] text-accent">Live · {day.name}</p>
          <h1 className="font-display text-2xl font-bold uppercase tracking-wide sm:text-3xl">{ex?.name ?? '…'}</h1>
        </div>
        <Button variant="ghost" onClick={finish}>Finish workout</Button>
      </div>

      <nav className="mb-5 flex gap-1.5 overflow-x-auto pb-1" aria-label="Exercises">
        {day.items.map((it, i) => {
          const n = logs.filter((l) => l.exercise_id === it.exercise_id).length
          return (
            <button key={it.exercise_id} onClick={() => setIdx(i)} aria-current={i === idx ? 'step' : undefined}
              className={`shrink-0 rounded-md border px-3 py-1.5 text-xs transition-colors ${i === idx ? 'border-accent text-bone' : n >= it.sets ? 'border-sage/40 text-sage' : 'border-iron-700 text-ash hover:text-bone'}`}>
              {String(i + 1).padStart(2, '0')} · {catalog[it.exercise_id]?.name ?? it.exercise_id} {n > 0 && `(${n}/${it.sets})`}
            </button>
          )
        })}
      </nav>

      <div className="grid gap-5 lg:grid-cols-[1.25fr_1fr]">
        <div className="space-y-4">
          <div className="h-80 sm:h-[26rem]">{ex && <Suspense fallback={<Spinner />}><Trainer3D anim={ex.anim} props={ex.props} label={ex.name} /></Suspense>}</div>
          {ex && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Card title="Cues">
                <ul className="list-disc space-y-1.5 pl-4 text-sm">{ex.cues.map((c) => <li key={c}>{c}</li>)}</ul>
              </Card>
              <Card title="Avoid">
                <ul className="list-disc space-y-1.5 pl-4 text-sm text-ash">{ex.mistakes.map((c) => <li key={c}>{c}</li>)}</ul>
              </Card>
            </div>
          )}
        </div>

        <div className="space-y-4">
          <TimerPanel />

          <Card title={`Set ${Math.min(mine.length + 1, item.sets)} of ${item.sets}`} action={<span className="font-mono text-sm">{fmtTarget(item)}</span>}>
            {item.rx?.load_kg != null && <p className="mb-3 text-sm">Target: <span className="font-mono text-accent-hi">{fmtLoad(item.rx.load_kg, units)} × {item.rx.reps}</span></p>}
            {item.rx?.note && <p className="mb-3 text-sm text-ash">{item.rx.note}</p>}
            <form onSubmit={logSet} className="grid grid-cols-3 gap-3">
              {ex?.load ? (
                <Field label={`Load (${units})`}><input type="number" min={0} step={0.25} inputMode="decimal" value={form.load} onChange={(e) => setForm({ ...form, load: e.target.value })} placeholder="0" /></Field>
              ) : <div className="self-end pb-2 text-xs text-ash">Bodyweight</div>}
              <Field label={timed ? 'Seconds' : 'Reps'}><input type="number" min={0} max={600} required inputMode="numeric" value={form.reps} onChange={(e) => setForm({ ...form, reps: e.target.value })} /></Field>
              {!timed && (
                <Field label="Left in tank">
                  <select value={form.rir} onChange={(e) => setForm({ ...form, rir: e.target.value })} aria-describedby="rir-hint">
                    <option value="0">0 — failure</option><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4+</option>
                  </select>
                </Field>
              )}
              <Button className="col-span-3" busy={busy}>Log set</Button>
            </form>
            <p id="rir-hint" className="mt-2 text-[11px] text-ash/80">“Left in tank” = reps you could still have done. It sharpens the next prescription.</p>
            {err && <div className="mt-3"><Alert tone="error">{err}</Alert></div>}

            {mine.length > 0 && (
              <ul className="mt-4 divide-y divide-iron-800 border-t border-iron-800 text-sm">
                {mine.map((l) => (
                  <li key={l.id} className="flex items-center justify-between py-2 font-mono">
                    <span>#{l.set_number} · {l.load_kg ? fmtLoad(l.load_kg, units) : 'BW'} × {l.reps}{timed ? 's' : ''}{l.rir != null && <span className="text-ash"> @{l.rir}</span>}</span>
                    <button className="font-sans text-xs text-ash hover:text-ember" onClick={() => undo(l.id)} aria-label={`Delete set ${l.set_number}`}>Undo</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex justify-between gap-2">
              <Button variant="ghost" disabled={idx === 0} onClick={() => setIdx(idx - 1)}>← Prev</Button>
              {idx < day.items.length - 1
                ? <Button variant={mine.length >= item.sets ? 'primary' : 'ghost'} onClick={() => setIdx(idx + 1)}>Next exercise →</Button>
                : <Button variant={mine.length >= item.sets ? 'primary' : 'ghost'} onClick={finish}>Finish</Button>}
            </div>
          </Card>

          {ex?.track && PROFILES[ex.track] && (
            camera
              ? <RepCounter track={ex.track} onUse={(n) => setForm((f) => ({ ...f, reps: String(n) }))} onStop={() => setCamera(false)} />
              : <Button variant="ghost" className="w-full" onClick={() => setCamera(true)}>Count reps with camera</Button>
          )}
        </div>
      </div>
    </>
  )
}

function RepCounter({ track, onUse, onStop }: { track: string; onUse: (n: number) => void; onStop: () => void }) {
  const counter = useRef<ReturnType<typeof createCounter> | null>(null)
  const [s, setS] = useState<CounterState | null>(null)
  const p = PROFILES[track]
  return (
    <div className="space-y-3">
      <Suspense fallback={<Spinner />}>
        <PoseCamera onStop={onStop} onFrame={({ lm, width, height }) => {
          counter.current ??= createCounter(p, width / height)
          setS(counter.current(lm, performance.now()))
        }} />
      </Suspense>
      <div className="flex items-center gap-4 rounded-xl border border-iron-700 bg-iron-900 p-4">
        <div className="text-center">
          <div className="font-mono text-5xl font-bold tabular-nums" aria-live="polite">{s?.reps ?? 0}</div>
          <div className="text-[11px] uppercase tracking-wider text-ash">reps</div>
        </div>
        <div className="flex-1 text-sm">
          <div aria-live="polite" className={s?.phase === 'check' ? 'text-lg font-semibold text-ember' : s?.visible === false ? 'text-ember' : 'text-bone'}>{s?.cue ?? 'Waiting for the camera…'}</div>
          <div className="mt-1 font-mono text-xs text-ash">{p.label} {s?.angle != null ? `${Math.round(s.angle)}°` : '—'} · counts {p.start === 'high' ? `${p.hi}° → ${p.lo}° → ${p.hi}°` : `${p.lo}° → ${p.hi}° → ${p.lo}°`}</div>
        </div>
        <div className="flex flex-col gap-2">
          <Button onClick={() => onUse(s?.reps ?? 0)} disabled={!s?.reps}>Use {s?.reps ?? 0}</Button>
          <Button variant="ghost" onClick={() => { counter.current = null; setS(null) }}>Reset</Button>
        </div>
      </div>
      <p className="text-[11px] text-ash/80">Film side-on, whole body in frame. A quick live check comes first — move your arm on each cue — so a replayed video can’t count; it repeats if you leave the frame. Only full, controlled reps count, and the count fills the reps box only when you press Use.</p>
    </div>
  )
}
