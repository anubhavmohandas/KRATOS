import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api, fromKg, toKg, useApi, type Assessment, type Profile } from '../api'
import PoseCamera, { type Frame } from '../vision/PoseCamera'
import { frontMetrics, median, shoulderSpan, sideMetrics } from '../vision/metrics'
import { tone } from '../timer/Timer'
import { Alert, Button, Card, Field, PageHead } from '../ui'

type Step = 'intro' | 'front' | 'side' | 'result'
type Metrics = Record<string, number>
const FRAMES = 30

const LABEL: Record<string, [string, (v: number) => string]> = {
  shoulder_hip_ratio: ['Shoulder ÷ hip joint width', (v) => v.toFixed(2)],
  leg_torso_ratio: ['Leg ÷ torso length', (v) => v.toFixed(2)],
  shoulder_width_cm_est: ['Shoulder joint width (est.)', (v) => `${v.toFixed(1)} cm`],
  hip_width_cm_est: ['Hip joint width (est.)', (v) => `${v.toFixed(1)} cm`],
  shoulder_tilt_deg: ['Shoulder tilt', (v) => `${Math.abs(v).toFixed(1)}° ${Math.abs(v) < 1 ? 'level' : v > 0 ? 'left lower' : 'right lower'}`],
  hip_tilt_deg: ['Hip tilt', (v) => `${Math.abs(v).toFixed(1)}° ${Math.abs(v) < 1 ? 'level' : v > 0 ? 'left lower' : 'right lower'}`],
  head_forward_ratio: ['Head ahead of shoulder', (v) => `${(v * 100).toFixed(0)}% of torso`],
  landmark_quality: ['Landmark confidence', (v) => `${Math.round(v * 100)}%`],
}
const MANUAL = ['waist_cm', 'chest_cm', 'hips_cm', 'arm_cm', 'thigh_cm'] as const
for (const k of MANUAL) LABEL[k] = [k[0].toUpperCase() + k.slice(1, -3), (v) => `${v} cm`]

export default function Body({ profile }: { profile: Profile }) {
  const history = useApi<Assessment[]>('/assessments')
  const [step, setStep] = useState<Step>('intro')
  const [result, setResult] = useState<Metrics>({})
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  async function save(body: Record<string, unknown>) {
    setMsg(null)
    try {
      await api.send('/assessments', 'POST', body)
      setMsg({ tone: 'ok', text: 'Saved.' })
      history.reload()
      return true
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message })
      return false
    }
  }

  const finite = (m: Metrics) => Object.fromEntries(Object.entries(m).filter(([, v]) => Number.isFinite(v)))

  return (
    <>
      <PageHead kicker="Body Lab" title="Assess & measure" />
      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Camera scan" className={step === 'front' || step === 'side' ? 'lg:col-span-2' : ''}>
          {step === 'intro' && (
            <div className="space-y-4 text-sm">
              <p className="text-ash">A guided front and side capture estimates proportions and posture from body landmarks. Do it in the same spot, light and clothing each time so the trend means something.</p>
              <ul className="list-disc space-y-1 pl-5 text-ash">
                <li>Camera at hip height, 2–3 m away, whole body in frame head to feet.</li>
                <li>Fitted clothing, arms slightly away from your sides.</li>
                <li>Frames are processed on this device. Only the numbers are saved — never images.</li>
              </ul>
              <Alert>These are visual estimates, not clinical measurements. KRATOS doesn’t estimate body-fat % from a camera — it isn’t reliable enough to show as a fact. Use a tape for circumferences.</Alert>
              <Button onClick={() => setStep('front')}>Start scan</Button>
            </div>
          )}
          {(step === 'front' || step === 'side') && (
            <Capture key={step} step={step} heightCm={profile.height_cm} onCancel={() => setStep('intro')}
              onDone={(m) => {
                setResult((r) => ({ ...r, ...m }))
                setStep(step === 'front' ? 'side' : 'result')
              }}
              onSkip={step === 'side' ? () => setStep('result') : undefined} />
          )}
          {step === 'result' && (
            <div className="space-y-4">
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                {Object.entries(result).map(([k, v]) => LABEL[k] && (
                  <div key={k} className="border-b border-iron-800 pb-2">
                    <dt className="text-xs text-ash">{LABEL[k][0]}</dt>
                    <dd className="font-mono text-lg">{LABEL[k][1](v)}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-ash">Joint widths are measured between joint centres (not the outer edge of the body), calibrated from your height of {profile.height_cm} cm.</p>
              <div className="flex gap-2">
                <Button onClick={async () => (await save({ kind: 'camera', ...finite(result) })) && setStep('intro')}>Save results</Button>
                <Button variant="ghost" onClick={() => { setResult({}); setStep('front') }}>Rescan</Button>
              </div>
            </div>
          )}
        </Card>

        <div className="space-y-5">
          <ManualForm profile={profile} save={save} />
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        </div>
      </div>

      <Card title="History" className="mt-5">
        {!history.data?.length ? <p className="text-sm text-ash">No assessments yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ash">
                <tr><th className="py-2 pr-4 font-medium">Date</th><th className="pr-4 font-medium">Type</th><th className="pr-4 font-medium">Values</th><th /></tr>
              </thead>
              <tbody className="divide-y divide-iron-800">
                {history.data.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">{new Date(a.measured_at).toLocaleDateString()}</td>
                    <td className="pr-4 text-ash">{a.kind}</td>
                    <td className="pr-4 text-xs">
                      {Object.entries(a).filter(([k]) => !['id', 'kind', 'measured_at', 'landmark_quality'].includes(k)).map(([k, v]) =>
                        <span key={k} className="mr-3 inline-block">{k === 'weight_kg' ? 'Weight' : LABEL[k]?.[0] ?? k}: <span className="font-mono text-bone">{k === 'weight_kg' ? `${fromKg(+v, profile.units)} ${profile.units}` : LABEL[k] ? LABEL[k][1](+v) : v}</span></span>)}
                    </td>
                    <td className="text-right"><button className="text-xs text-ash hover:text-ember" aria-label="Delete entry" onClick={async () => { await api.send(`/assessments/${a.id}`, 'DELETE'); history.reload() }}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}

/** Spoken cues, so the scan works from across the room. Queued, never interrupting. */
function say(text: string) {
  try {
    speechSynthesis.speak(new SpeechSynthesisUtterance(text))
  } catch { /* no speech synthesis — beeps and the on-screen text still guide */ }
}

const STEADY_MS = 1500 // in position this long → countdown starts by itself
const COUNTDOWN_MS = 3000

function Capture({ step, heightCm, onDone, onCancel, onSkip }: { step: 'front' | 'side'; heightCm: number; onDone: (m: Metrics) => void; onCancel: () => void; onSkip?: () => void }) {
  const state = useRef({ mode: 'aim' as 'aim' | 'countdown' | 'collect', at: 0, since: 0, beeped: 0, buf: [] as Metrics[] })
  const [auto, setAuto] = useState(true)
  const autoRef = useRef(auto)
  autoRef.current = auto
  const [view, setView] = useState({ mode: 'aim', quality: 0, secs: 0, got: 0, facing: false, seen: false })
  const minQ = step === 'front' ? 0.75 : 0.6

  useEffect(() => {
    say(step === 'front' ? 'Face the camera, arms a little out from your sides.' : 'Now turn to your side and stand naturally.')
  }, [step])

  function begin() {
    Object.assign(state.current, { mode: 'countdown', at: performance.now() + COUNTDOWN_MS, beeped: 0, buf: [] })
    say('Hold still')
  }

  function onFrame({ lm, width, height }: Frame) {
    const s = state.current
    const now = performance.now()
    const m: Metrics = lm.length ? (step === 'front' ? frontMetrics(lm, width, height, heightCm) : sideMetrics(lm, width, height)) : { landmark_quality: 0 }
    // Front needs shoulders spread across the frame; side needs them stacked — so a front pose can't pass as the side view.
    const facing = lm.length > 0 && (step === 'front' ? shoulderSpan(lm, width, height) > 0.45 : shoulderSpan(lm, width, height) < 0.3)
    const ok = m.landmark_quality >= minQ && facing

    if (s.mode === 'aim') {
      s.since = ok ? s.since || now : 0
      if (autoRef.current && ok && now - s.since >= STEADY_MS) begin()
    }
    if (s.mode === 'countdown') {
      const left = Math.ceil((s.at - now) / 1000)
      if (left >= 1 && left !== s.beeped) {
        s.beeped = left
        tone(880, 0.12)
      }
      if (now >= s.at) {
        s.mode = 'collect'
        tone(1320, 0.2)
      }
    }
    if (s.mode === 'collect' && ok) s.buf.push(m)
    if (s.buf.length >= FRAMES) {
      s.mode = 'aim'
      tone(988, 0.2, 2)
      say(step === 'front' ? 'Got it.' : 'Scan complete.')
      onDone(median(s.buf))
      return
    }
    setView({ mode: s.mode, quality: m.landmark_quality, secs: Math.max(0, Math.ceil((s.at - now) / 1000)), got: s.buf.length, facing, seen: lm.length > 0 })
  }

  const ready = view.quality >= minQ && view.facing
  // Big enough to read from 3 m away.
  const big = view.mode === 'countdown' ? String(view.secs)
    : view.mode === 'collect' ? 'Hold still'
      : !view.seen ? 'Step into frame'
        : view.quality < minQ ? 'Step back — head to feet in view'
          : !view.facing ? (step === 'front' ? 'Face the camera' : 'Turn sideways')
            : auto ? 'Hold that…' : 'Ready'

  return (
    <div className="space-y-3">
      <p className="text-sm"><span className="font-display font-semibold uppercase tracking-wide text-accent">{step === 'front' ? 'Step 1 · Face the camera' : 'Step 2 · Turn side-on'}</span>
        <span className="ml-2 text-ash">{step === 'front' ? 'Stand tall, feet hip-width, arms a little out.' : 'Stand naturally — don’t correct your posture.'}</span></p>
      <PoseCamera onFrame={onFrame} onStop={onCancel}>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 bg-gradient-to-t from-black/85 to-transparent px-4 pb-5 pt-12 text-center" aria-live="polite">
          <span className={`font-display font-bold uppercase leading-none tracking-wide ${view.mode === 'countdown' ? 'text-8xl text-accent' : `text-3xl sm:text-5xl ${ready || view.mode === 'collect' ? 'text-accent' : 'text-bone'}`}`}>{big}</span>
          {view.mode === 'collect' && <span className="h-1.5 w-48 overflow-hidden rounded bg-white/20"><span className="block h-full bg-accent" style={{ width: `${(view.got / FRAMES) * 100}%` }} /></span>}
        </div>
      </PoseCamera>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex flex-1 items-center gap-2 text-sm">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          Auto-capture when I’m in position <span className="text-xs text-ash">(with voice cues)</span>
        </label>
        {onSkip && <Button variant="ghost" onClick={onSkip}>Skip side view</Button>}
        <Button variant={auto ? 'ghost' : 'primary'} disabled={!ready || view.mode !== 'aim'} onClick={begin}>Capture now</Button>
      </div>
    </div>
  )
}

function ManualForm({ profile, save }: { profile: Profile; save: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [f, setF] = useState<Record<string, string>>({ weight: String(fromKg(profile.weight_kg, profile.units)) })
  const [busy, setBusy] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    const body: Record<string, unknown> = { kind: 'manual' }
    if (f.weight) body.weight_kg = +toKg(+f.weight, profile.units).toFixed(2)
    for (const k of MANUAL) if (f[k]) body[k] = +f[k]
    if (await save(body)) setF({ weight: f.weight })
    setBusy(false)
  }
  return (
    <Card title="Tape & scale">
      <form onSubmit={submit} className="grid grid-cols-2 gap-3">
        <Field label={`Body weight (${profile.units})`}><input type="number" step={0.1} min={20} max={800} value={f.weight ?? ''} onChange={(e) => setF({ ...f, weight: e.target.value })} /></Field>
        {MANUAL.map((k) => (
          <Field key={k} label={`${k.split('_')[0][0].toUpperCase()}${k.split('_')[0].slice(1)} (cm)`}>
            <input type="number" step={0.1} min={10} max={250} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </Field>
        ))}
        <Button className="col-span-2" variant="ghost" busy={busy}>Save measurements</Button>
      </form>
      <p className="mt-3 text-[11px] text-ash/80">Measure waist at the navel, relaxed, same time of day. Weight changes alone don’t prove muscle gain or fat loss.</p>
    </Card>
  )
}
