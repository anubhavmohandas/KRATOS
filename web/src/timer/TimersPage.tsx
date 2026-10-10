import { useRef, useState } from 'react'
import { total, type TimerCfg } from './logic'
import { alertVolume, phaseText, timeText, tone, TimerPanel, useTimer } from './Timer'
import { Button, Card, Field } from '../ui'

const PRESETS: { name: string; cfg: TimerCfg }[] = [
  { name: 'Rest 60s', cfg: { kind: 'countdown', seconds: 60, label: 'Rest' } },
  { name: 'Rest 90s', cfg: { kind: 'countdown', seconds: 90, label: 'Rest' } },
  { name: 'Rest 2 min', cfg: { kind: 'countdown', seconds: 120, label: 'Rest' } },
  { name: 'Rest 3 min', cfg: { kind: 'countdown', seconds: 180, label: 'Rest' } },
  { name: 'Warm-up 5 min', cfg: { kind: 'countdown', seconds: 300, label: 'Warm-up' } },
  { name: 'Stopwatch', cfg: { kind: 'stopwatch', label: 'Stopwatch' } },
  { name: 'Tabata 20/10 × 8', cfg: { kind: 'intervals', work: 20, rest: 10, rounds: 8, prepare: 10, label: 'Tabata' } },
  { name: 'EMOM 10 min', cfg: { kind: 'intervals', work: 60, rest: 0, rounds: 10, prepare: 10, label: 'EMOM' } },
  { name: '30/30 × 10', cfg: { kind: 'intervals', work: 30, rest: 30, rounds: 10, prepare: 10, label: 'Intervals 30/30' } },
]

const clampInt = (v: string, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(+v || 0)))

export default function TimersPage() {
  const timer = useTimer()
  const [cd, setCd] = useState({ min: '1', sec: '30' })
  const [iv, setIv] = useState({ work: '40', rest: '20', rounds: '6', prepare: '10' })
  const [vol, setVol] = useState(alertVolume.get())
  const stage = useRef<HTMLDivElement>(null)
  const custom: TimerCfg = { kind: 'intervals', work: clampInt(iv.work, 1, 3600), rest: clampInt(iv.rest, 0, 3600), rounds: clampInt(iv.rounds, 1, 100), prepare: clampInt(iv.prepare, 0, 60), label: 'Custom intervals' }

  return (
    <div className="space-y-5">
      {timer.run ? (
        <div className="space-y-2">
          <TimerPanel big />
          <button className="text-xs font-semibold text-accent hover:underline" onClick={() => stage.current?.requestFullscreen?.()}>Full screen</button>
        </div>
      ) : <p className="text-sm text-ash">Start a timer below. It keeps running while you move around KRATOS, and alerts with sound, vibration and — if the tab is in the background — a notification.</p>}

      {/* Full-screen stage: huge digits, readable from across the room. */}
      <div ref={stage} className="hidden flex-col items-center justify-center gap-6 bg-iron-950 [&:fullscreen]:flex">
        {timer.run && timer.v && (
          <>
            <div className="font-display text-4xl uppercase tracking-widest text-ash">{phaseText(timer.run, timer.v)}</div>
            <div className={`font-mono text-[24vw] leading-none font-bold tabular-nums ${timer.v.phase === 'rest' ? 'text-bone' : 'text-accent'}`}>{timeText(timer.run, timer.v)}</div>
            <div className="flex gap-3">
              <Button variant="ghost" onClick={timer.toggle}>{timer.run.pausedAt ? 'Resume' : 'Pause'}</Button>
              <Button variant="ghost" onClick={() => document.exitFullscreen()}>Exit</Button>
            </div>
          </>
        )}
      </div>

      <Card title="Quick start">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => <Button key={p.name} variant="ghost" onClick={() => timer.start(p.cfg)}>{p.name}</Button>)}
        </div>
      </Card>

      <div className="grid gap-5 md:grid-cols-2">
        <Card title="Custom countdown">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Minutes"><input type="number" min={0} max={180} value={cd.min} onChange={(e) => setCd({ ...cd, min: e.target.value })} /></Field>
            <Field label="Seconds"><input type="number" min={0} max={59} value={cd.sec} onChange={(e) => setCd({ ...cd, sec: e.target.value })} /></Field>
          </div>
          <Button className="mt-4" onClick={() => timer.start({ kind: 'countdown', seconds: Math.max(1, clampInt(cd.min, 0, 180) * 60 + clampInt(cd.sec, 0, 59)), label: 'Countdown' })}>Start countdown</Button>
        </Card>
        <Card title="Custom intervals">
          <div className="grid grid-cols-4 gap-3">
            {(['work', 'rest', 'rounds', 'prepare'] as const).map((k) => (
              <Field key={k} label={k === 'rounds' ? 'Rounds' : `${k[0].toUpperCase()}${k.slice(1)} s`}>
                <input type="number" min={k === 'work' || k === 'rounds' ? 1 : 0} value={iv[k]} onChange={(e) => setIv({ ...iv, [k]: e.target.value })} />
              </Field>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Button onClick={() => timer.start(custom)}>Start intervals</Button>
            <span className="font-mono text-xs text-ash">total {Math.floor(total(custom) / 60)}:{String(total(custom) % 60).padStart(2, '0')}</span>
          </div>
        </Card>
      </div>

      <Card title="Alerts">
        <div className="flex flex-wrap items-end gap-4">
          <Field label={`Alert volume — ${Math.round(vol * 100)}% (separate from music)`}>
            <input type="range" min={0} max={1} step={0.05} value={vol} className="!px-0 accent-accent" onChange={(e) => { setVol(+e.target.value); alertVolume.set(+e.target.value) }} />
          </Field>
          <Button variant="ghost" onClick={() => tone(1175, 0.16, 2)}>Test sound</Button>
          {'Notification' in window && Notification.permission !== 'granted' && (
            <Button variant="ghost" onClick={() => Notification.requestPermission()}>Allow notifications</Button>
          )}
        </div>
        <p className="mt-3 text-[11px] text-ash/80">Browsers slow background tabs, so an alert in a hidden tab can arrive a little late — the time shown is always exact. Playing music keeps the tab awake.</p>
      </Card>
    </div>
  )
}
