import { useEffect, useState, type FormEvent } from 'react'
import { api, fromKg, LABELS, local, NEXT_DAY_KEY, SESSION_KEY, toKg, useApi, type Equipment, type Profile, type Units } from '../api'
import { Alert, Button, Card, Chip, Field, Spinner } from '../ui'

const LOADABLE = ['dumbbells', 'kettlebell', 'barbell', 'cable']
const TYPES = ['dumbbells', 'pull_up_bar', 'bench', 'bands', 'kettlebell', 'barbell', 'rack', 'dip_bars', 'cable']
const DEFAULT: Profile = {
  age: 25, height_cm: 175, weight_kg: 75, experience: 'beginner', goal: 'muscle_gain',
  days_per_week: 3, session_minutes: 45, limitations: [], location: 'home', units: 'kg',
}
const range = (a: number, b: number, step: number) => Array.from({ length: Math.floor((b - a) / step + 1e-9) + 1 }, (_, i) => +(a + i * step).toFixed(3))
const GYM: Omit<Equipment, 'id'>[] = [
  { type: 'dumbbells', weights_kg: range(2.5, 50, 2.5) },
  { type: 'barbell', weights_kg: range(20, 200, 2.5) },
  { type: 'kettlebell', weights_kg: range(8, 32, 4) },
  { type: 'cable', weights_kg: range(5, 100, 5) },
  ...['rack', 'bench', 'pull_up_bar', 'dip_bars', 'bands'].map((type) => ({ type, weights_kg: [] })),
]

/** Goals, body basics, limitations and equipment — everything the engine plans from. */
export default function ProfileAndGear({ onSaved }: { onSaved: (p: Profile) => void }) {
  const prof = useApi<Profile | null>('/profile')
  const equip = useApi<Equipment[]>('/equipment')
  const [p, setP] = useState<Profile>(DEFAULT)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (prof.data) setP(prof.data)
  }, [prof.data])

  if (prof.loading) return <Spinner />
  if (prof.error) return <Alert tone="error">{prof.error.message}</Alert>

  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setP((x) => ({ ...x, [k]: v }))
  const num = (k: 'age' | 'height_cm' | 'days_per_week' | 'session_minutes') => (e: { target: { value: string } }) => set(k, +e.target.value)

  async function save(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setMsg(null)
    try {
      const saved = await api.send<Profile>('/profile', 'PUT', p)
      setMsg({ tone: 'ok', text: 'Profile saved.' })
      onSaved(saved)
    } catch (err) {
      setMsg({ tone: 'error', text: (err as Error).message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
        <Card title="Profile">
          <form onSubmit={save} className="space-y-5">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Field label="Age"><input type="number" min={13} max={100} required value={p.age} onChange={num('age')} /></Field>
              <Field label="Height (cm)"><input type="number" min={100} max={250} step={0.5} required value={p.height_cm} onChange={num('height_cm')} /></Field>
              <Field label={`Weight (${p.units})`}>
                <input type="number" min={20} max={800} step={0.1} required value={fromKg(p.weight_kg, p.units)} onChange={(e) => set('weight_kg', toKg(+e.target.value, p.units))} />
              </Field>
              <Field label="Units">
                <select value={p.units} onChange={(e) => set('units', e.target.value as Units)}><option value="kg">kg</option><option value="lb">lb</option></select>
              </Field>
            </div>
            <Field label="Goal">
              <div className="flex flex-wrap gap-2">
                {(['muscle_gain', 'strength', 'fat_loss', 'general', 'endurance'] as const).map((g) => <Chip key={g} on={p.goal === g} onClick={() => set('goal', g)}>{LABELS[g]}</Chip>)}
              </div>
            </Field>
            <Field label="Experience">
              <div className="flex flex-wrap gap-2">
                {(['beginner', 'intermediate', 'advanced'] as const).map((x) => <Chip key={x} on={p.experience === x} onClick={() => set('experience', x)}>{LABELS[x]}</Chip>)}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Training days / week">
                <select value={p.days_per_week} onChange={num('days_per_week')}>{[2, 3, 4, 5, 6].map((d) => <option key={d}>{d}</option>)}</select>
              </Field>
              <Field label="Minutes per session">
                <select value={p.session_minutes} onChange={num('session_minutes')}>{[20, 30, 45, 60, 75, 90, 120].map((d) => <option key={d}>{d}</option>)}</select>
              </Field>
            </div>
            <Field label="Anything that hurts or needs care?" hint="Exercises that commonly aggravate these are left out. Not medical advice.">
              <div className="flex flex-wrap gap-2">
                {['knee', 'shoulder', 'lower_back', 'wrist', 'elbow'].map((l) => (
                  <Chip key={l} on={p.limitations.includes(l)} onClick={() => set('limitations', p.limitations.includes(l) ? p.limitations.filter((x) => x !== l) : [...p.limitations, l])}>{LABELS[l]}</Chip>
                ))}
              </div>
            </Field>
            {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
            <Button busy={saving}>{prof.data ? 'Save profile' : 'Save & continue'}</Button>
          </form>
        </Card>

        <EquipmentCard units={p.units} location={p.location} setLocation={(l) => set('location', l)} equip={equip} />
      </div>
    </>
  )
}

function EquipmentCard({ units, location, setLocation, equip }: {
  units: Units; location: Profile['location']; setLocation: (l: Profile['location']) => void; equip: ReturnType<typeof useApi<Equipment[]>>
}) {
  const [type, setType] = useState('dumbbells')
  const [mode, setMode] = useState<'list' | 'range'>('range')
  const [list, setList] = useState('')
  const [rng, setRng] = useState({ min: 2, max: 20, step: 2 })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const items = equip.data ?? []

  async function add(body: Omit<Equipment, 'id'>[]) {
    setBusy(true)
    setErr('')
    try {
      for (const b of body) await api.send('/equipment', 'POST', b)
      equip.reload()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    let weights: number[] = []
    if (LOADABLE.includes(type)) {
      const raw = mode === 'list' ? list.split(/[,\s]+/).filter(Boolean).map(Number) : range(rng.min, rng.max, rng.step)
      if (!raw.length || raw.some((w) => !(w > 0))) return setErr('Enter weights like “5, 7.5, 10” or a valid range.')
      weights = raw.map((w) => +toKg(w, units).toFixed(3))
    }
    add([{ type, weights_kg: weights }])
  }

  const summary = (e: Equipment) => {
    if (!e.weights_kg.length) return ''
    const w = e.weights_kg.map((k) => fromKg(k, units))
    return w.length <= 6 ? w.join(', ') + ` ${units}` : `${w[0]}–${w.at(-1)} ${units} · ${w.length} weights`
  }

  return (
    <Card title="Equipment" action={
      <div className="flex gap-1.5">
        <Chip on={location === 'home'} onClick={() => setLocation('home')}>Home</Chip>
        <Chip on={location === 'gym'} onClick={() => setLocation('gym')}>Gym</Chip>
      </div>
    }>
      {location === 'gym' && !items.length && (
        <div className="mb-4 rounded-lg border border-dashed border-iron-600 p-3 text-sm text-ash">
          Training at a commercial gym? <button className="font-semibold text-accent underline-offset-2 hover:underline" disabled={busy} onClick={() => add(GYM)}>Load a standard gym setup</button> and remove what yours lacks.
        </div>
      )}
      {equip.loading ? <Spinner /> : items.length === 0 ? (
        <p className="mb-4 text-sm text-ash">No equipment yet — bodyweight-only plans still work. Add what you own so KRATOS can use it.</p>
      ) : (
        <ul className="mb-5 divide-y divide-iron-800">
          {items.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 py-2.5">
              <div>
                <div className="font-medium">{LABELS[e.type] ?? e.type}</div>
                {summary(e) && <div className="font-mono text-xs text-ash">{summary(e)}{e.type === 'dumbbells' && ' per hand'}</div>}
              </div>
              <button aria-label={`Remove ${LABELS[e.type]}`} className="rounded px-2 py-1 text-xs text-ash hover:bg-iron-800 hover:text-ember"
                onClick={async () => {
                  setErr('')
                  try {
                    await api.send(`/equipment/${e.id}`, 'DELETE')
                    equip.reload()
                  } catch (x) { setErr((x as Error).message) }
                }}>Remove</button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} className="space-y-3 rounded-lg bg-iron-850 p-3">
        <Field label="Add equipment">
          <select value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{LABELS[t]}</option>)}</select>
        </Field>
        {LOADABLE.includes(type) && (
          <>
            <div className="flex gap-1.5">
              <Chip on={mode === 'range'} onClick={() => setMode('range')}>Adjustable / range</Chip>
              <Chip on={mode === 'list'} onClick={() => setMode('list')}>Fixed weights</Chip>
            </div>
            {mode === 'range' ? (
              <div className="grid grid-cols-3 gap-2">
                {(['min', 'max', 'step'] as const).map((k) => (
                  <Field key={k} label={`${k[0].toUpperCase() + k.slice(1)} (${units})`}>
                    <input type="number" min={0.25} step={0.25} value={rng[k]} onChange={(e) => setRng({ ...rng, [k]: +e.target.value })} />
                  </Field>
                ))}
              </div>
            ) : (
              <Field label={`Weights you own (${units})`} hint={type === 'dumbbells' ? 'Per dumbbell, e.g. 5, 7.5, 10, 12.5' : type === 'barbell' ? 'Total bar + plates options' : undefined}>
                <input value={list} onChange={(e) => setList(e.target.value)} placeholder="5, 7.5, 10" />
              </Field>
            )}
          </>
        )}
        {err && <Alert tone="error">{err}</Alert>}
        <Button variant="ghost" busy={busy}>Add {LABELS[type]}</Button>
      </form>
    </Card>
  )
}

type Snapshot = { name: string; bytes: number; taken_at: string }

/** Data that changed under the app: drop what this browser remembers about it and start fresh. */
function reloadFresh() {
  for (const k of [SESSION_KEY, NEXT_DAY_KEY, 'kratos.coach']) local.set(k, null)
  location.assign('/')
}

export function DataCard() {
  const snaps = useApi<Snapshot[]>('/backups')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  async function run(kind: string, fn: () => Promise<unknown>) {
    setBusy(kind)
    setErr('')
    try {
      await fn()
    } catch (e) {
      setErr((e as Error).message)
      setBusy('')
    }
  }
  const exportData = () => run('export', async () => {
    const data = await api.get('/export')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    a.download = `kratos-export-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    setBusy('')
  })
  const restore = (what: string, body?: FormData) => {
    if (!confirm(`Replace everything in KRATOS with ${what}? Today’s data is snapshotted first, so you can undo it from this list.`)) return
    run('restore', async () => {
      await api.send(body ? '/restore' : `/backups/${what}/restore`, 'POST', body)
      reloadFresh()
    })
  }
  const wipe = () => {
    if (!confirm('Delete your profile, equipment, plans, workouts and body data? A snapshot is kept in Backups for 14 days in case this was a mistake.')) return
    run('wipe', async () => {
      await api.send('/data', 'DELETE')
      reloadFresh()
    })
  }

  return (
    <>
      <Card title="Your data">
        <p className="mb-4 text-sm text-ash">Workouts and body data live in the KRATOS database on the server. Camera frames and uploaded PDFs are never saved.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" busy={busy === 'export'} onClick={exportData}>Export JSON</Button>
          <Button variant="danger" busy={busy === 'wipe'} onClick={wipe}>Delete everything</Button>
        </div>
      </Card>
      <Card title="Backups">
        <p className="mb-4 text-sm text-ash">A verified snapshot is taken every day and before a delete or restore; the last 14 are kept on the server. Download one now and then so a copy survives losing the server.</p>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <a href="/api/backup" download className="inline-flex items-center rounded-md bg-accent px-4 py-2 text-sm font-semibold text-iron-950 hover:bg-accent-hi">Download backup</a>
          <label className="relative cursor-pointer text-sm text-ash underline hover:text-bone">
            Restore from a file…
            <input type="file" accept=".db,application/vnd.sqlite3,application/octet-stream" className="sr-only left-0 top-0" disabled={!!busy} onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              const fd = new FormData()
              fd.append('file', f)
              restore(`“${f.name}”`, fd)
            }} />
          </label>
        </div>
        {err && <div className="mb-3"><Alert tone="error">{err}</Alert></div>}
        {snaps.loading ? <Spinner /> : !snaps.data?.length ? <p className="text-sm text-ash">No snapshots yet — the first is taken within an hour of starting.</p> : (
          <ul className="divide-y divide-iron-800 text-sm">
            {snaps.data.map((b) => (
              <li key={b.name} className="flex items-center justify-between gap-3 py-2">
                <span>{new Date(b.taken_at).toLocaleString()} <span className="font-mono text-xs text-ash">· {Math.max(1, Math.round(b.bytes / 1024))} KB</span></span>
                <Button variant="ghost" className="!px-3 !py-1 text-xs" disabled={!!busy} onClick={() => restore(b.name)}>Restore</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
