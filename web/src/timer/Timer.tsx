import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { elapsedMs, fmt, pause, resume, start, view, type Phase, type TimerCfg, type TimerRun, type View } from './logic'
import { Button } from '../ui'
import { Link } from '../router'

// ---- alerts: own volume, independent of music ----------------------------------------
let audio: AudioContext | null = null
export const alertVolume = {
  get: () => { try { return +(localStorage.getItem('kratos.alertVolume') ?? 0.6) } catch { return 0.6 } },
  set: (v: number) => { try { localStorage.setItem('kratos.alertVolume', String(v)) } catch { /* not persisted */ } },
}

export function tone(freq: number, secs = 0.2, count = 1) {
  try {
    audio ??= new AudioContext()
    for (let i = 0; i < count; i++) {
      const t = audio.currentTime + i * (secs + 0.08)
      const o = audio.createOscillator()
      const g = audio.createGain()
      o.frequency.value = freq
      g.gain.setValueAtTime(0.35 * alertVolume.get(), t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + secs)
      o.connect(g).connect(audio.destination)
      o.start(t)
      o.stop(t + secs)
    }
  } catch { /* no Web Audio — vibration and visuals still work */ }
}

const SOUNDS: Record<Phase, () => void> = {
  work: () => tone(1175, 0.16, 2),
  rest: () => tone(660, 0.35),
  prepare: () => tone(880, 0.15),
  run: () => {},
  done: () => tone(988, 0.22, 3),
}

function announce(v: View, label: string) {
  SOUNDS[v.phase]()
  navigator.vibrate?.(v.phase === 'done' ? [200, 100, 200, 100, 300] : 200)
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    new Notification(v.phase === 'done' ? `${label} — done` : `${label}: ${v.phase} ${v.rounds > 1 ? `· round ${v.round}/${v.rounds}` : ''}`, { icon: '/icon.svg', silent: true })
  }
}

// ---- one global timer, survives navigation and reloads -------------------------------
type Ctx = {
  run: TimerRun | null
  v: View | null
  start: (cfg: TimerCfg) => void
  toggle: () => void
  add: (secs: number) => void
  stop: () => void
}
const TimerCtx = createContext<Ctx>(null!)
export const useTimer = () => useContext(TimerCtx)

const KEY = 'kratos.timer'
const load = (): TimerRun | null => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null') } catch { return null } }

export function TimerProvider({ children }: { children: ReactNode }) {
  const [run, setRun] = useState<TimerRun | null>(load)
  const [now, setNow] = useState(Date.now())
  const last = useRef('')
  const tick = useRef('')

  useEffect(() => {
    try { if (run) localStorage.setItem(KEY, JSON.stringify(run)); else localStorage.removeItem(KEY) } catch { /* not persisted */ }
    if (!run || run.pausedAt) return
    const t = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(t)
  }, [run])

  const v = run ? view(run.cfg, elapsedMs(run, now)) : null

  useEffect(() => {
    if (!v || !run) return void (last.current = '')
    const key = `${v.phase}:${v.round}`
    if (last.current && key !== last.current) announce(v, run.cfg.label)
    last.current = key
    const s = Math.ceil(v.remaining / 1000)
    if (v.phase !== 'done' && v.phase !== 'run' && s <= 3 && s >= 1 && tick.current !== `${key}:${s}`) {
      tick.current = `${key}:${s}`
      tone(440, 0.07)
    }
  })

  const ctx: Ctx = {
    run,
    v,
    start: (cfg) => {
      audio ??= new AudioContext() // unlock audio inside the user's click
      if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()
      last.current = ''
      setNow(Date.now())
      setRun(start(cfg, Date.now()))
    },
    toggle: () => setRun((r) => r && (r.pausedAt ? resume(r, Date.now()) : pause(r, Date.now()))),
    add: (secs) => setRun((r) => (r && r.cfg.kind === 'countdown' ? { ...r, cfg: { ...r.cfg, seconds: r.cfg.seconds + secs } } : r)),
    stop: () => setRun(null),
  }
  return <TimerCtx.Provider value={ctx}>{children}</TimerCtx.Provider>
}

// ---- displays ----------------------------------------------------------------------
const PHASE: Record<Phase, string> = { prepare: 'Get ready', work: 'Work', rest: 'Rest', run: 'Running', done: 'Done' }

export function timeText(run: TimerRun, v: View) {
  return run.cfg.kind === 'stopwatch' ? fmt(v.elapsed, false) : fmt(v.remaining)
}

export function phaseText(run: TimerRun, v: View) {
  if (run.cfg.kind === 'countdown') return v.phase === 'done' ? 'Time — go' : run.cfg.label
  return `${PHASE[v.phase]}${v.rounds > 1 && v.phase !== 'done' ? ` · ${v.round}/${v.rounds}` : ''}`
}

/** Compact live timer with controls — used in the workout, dashboard and My Space. */
export function TimerPanel({ big = false }: { big?: boolean }) {
  const { run, v, toggle, add, stop } = useTimer()
  if (!run || !v) return null
  const done = v.phase === 'done'
  const pct = v.phaseLen ? Math.min(100, (1 - v.remaining / v.phaseLen) * 100) : 0
  const look = done ? 'border-sage/50 bg-sage/10' : v.phase === 'rest' || v.phase === 'prepare' ? 'border-iron-600 bg-iron-850' : 'border-accent/50 bg-accent/10'
  return (
    <div className={`relative overflow-hidden rounded-xl border p-4 ${look}`} role="timer" aria-label={run.cfg.label}>
      <div className="absolute inset-x-0 bottom-0 h-1 bg-iron-800"><div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} /></div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className={`font-mono font-bold tabular-nums ${big ? 'text-6xl' : 'text-4xl'} ${run.pausedAt ? 'opacity-50' : ''}`}>{timeText(run, v)}</div>
        <div className="min-w-0 flex-1 text-sm">
          <div className={done ? 'font-semibold text-sage' : 'font-semibold'}>{phaseText(run, v)}</div>
          {run.cfg.kind !== 'countdown' && <div className="truncate text-xs text-ash">{run.cfg.label}</div>}
        </div>
        <div className="flex gap-2">
          {!done && <Button variant="ghost" onClick={toggle}>{run.pausedAt ? 'Resume' : 'Pause'}</Button>}
          {!done && run.cfg.kind === 'countdown' && <Button variant="ghost" onClick={() => add(15)}>+15s</Button>}
          <Button variant="ghost" onClick={stop}>{done ? 'Dismiss' : run.cfg.kind === 'countdown' ? 'Skip' : 'Stop'}</Button>
        </div>
      </div>
    </div>
  )
}

/** Shell badge so a running timer is visible from any page. */
export function TimerChip() {
  const { run, v } = useTimer()
  if (!run || !v) return null
  return (
    <Link href="/space/timers" className={`flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-sm tabular-nums ${v.phase === 'done' ? 'border-sage/60 text-sage' : 'border-accent/60 text-accent'}`}>
      <span className={`size-2 rounded-full ${run.pausedAt ? 'bg-ash' : v.phase === 'done' ? 'bg-sage' : 'animate-pulse bg-accent'}`} aria-hidden />
      {timeText(run, v)} <span className="font-sans text-xs text-ash">{phaseText(run, v)}</span>
    </Link>
  )
}
