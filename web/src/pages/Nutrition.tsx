import { useState, type FormEvent } from 'react'
import { api, today, useApi, type Profile } from '../api'
import { Alert, Button, Card, Field, Spinner } from '../ui'

type Meal = { id: number; day: string; name: string; kcal: number | null; protein_g: number | null }

// Daily protein per kg of body weight by goal, within the 1.2–2.2 g/kg range sports-nutrition reviews support.
const PROTEIN_PER_KG: Record<Profile['goal'], number> = { muscle_gain: 1.8, strength: 1.8, fat_loss: 2.0, general: 1.4, endurance: 1.6 }

const sum = (ms: Meal[], k: 'kcal' | 'protein_g') => Math.round(ms.reduce((t, m) => t + (m[k] ?? 0), 0))

/** Single-value meter against a target: the number is the label, the bar repeats it. */
function Meter({ label, value, target, unit }: { label: string; value: number; target: number | null; unit: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-ash">{label}</span>
        <span className="font-mono"><span className="text-lg font-bold text-bone">{value}</span>{target ? <span className="text-ash"> / {target} {unit}</span> : <span className="text-ash"> {unit}</span>}</span>
      </div>
      {target != null && (
        <div className="mt-1.5 h-2 overflow-hidden rounded bg-iron-800" role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={target}>
          <div className="h-full rounded bg-accent" style={{ width: `${Math.min(100, (value / target) * 100)}%` }} />
        </div>
      )}
    </div>
  )
}

export default function Nutrition({ profile, onProfile }: { profile: Profile; onProfile: (p: Profile) => void }) {
  const since = today(new Date(Date.now() - 6 * 864e5))
  const meals = useApi<Meal[]>(`/meals?since=${since}`)
  const [f, setF] = useState({ name: '', kcal: '', protein: '' })
  const [target, setTarget] = useState(String(profile.kcal_target ?? ''))
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const protein = Math.round(profile.weight_kg * PROTEIN_PER_KG[profile.goal])
  const all = meals.data ?? []
  const todays = all.filter((m) => m.day === today())

  async function run(kind: string, fn: () => Promise<unknown>) {
    setBusy(kind)
    setErr('')
    try {
      await fn()
    } catch (x) {
      setErr((x as Error).message)
    } finally {
      setBusy('')
    }
  }
  const add = (e: FormEvent) => {
    e.preventDefault()
    run('add', async () => {
      await api.send('/meals', 'POST', { day: today(), name: f.name, kcal: f.kcal ? +f.kcal : undefined, protein_g: f.protein ? +f.protein : undefined })
      setF({ name: '', kcal: '', protein: '' })
      meals.reload()
    })
  }
  const saveTarget = (e: FormEvent) => {
    e.preventDefault()
    run('target', async () => onProfile(await api.send<Profile>('/profile', 'PUT', { ...profile, kcal_target: target ? +target : null })))
  }

  if (meals.loading) return <Spinner />
  const week = Array.from({ length: 7 }, (_, i) => today(new Date(Date.now() - (6 - i) * 864e5)))
  return (
    <div className="grid gap-5 lg:grid-cols-[1.2fr_1fr]">
      <div className="space-y-5">
        <Card title="Today">
          <div className="space-y-4">
            <Meter label="Protein" value={sum(todays, 'protein_g')} target={protein} unit="g" />
            <Meter label="Calories" value={sum(todays, 'kcal')} target={profile.kcal_target ?? null} unit="kcal" />
          </div>
          <p className="mt-3 text-[11px] text-ash/80">Protein target: {PROTEIN_PER_KG[profile.goal]} g per kg of body weight for your goal. Set your own calorie target below; KRATOS doesn’t guess your energy needs.</p>
          {todays.length > 0 && (
            <ul className="mt-4 divide-y divide-iron-800 border-t border-iron-800 text-sm">
              {todays.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate">{m.name}</span>
                  <span className="font-mono text-xs text-ash">{m.kcal != null && `${m.kcal} kcal`}{m.kcal != null && m.protein_g != null && ' · '}{m.protein_g != null && `${m.protein_g} g`}</span>
                  <button className="text-xs text-ash hover:text-ember" aria-label={`Delete ${m.name}`} onClick={() => run('del', async () => { await api.send(`/meals/${m.id}`, 'DELETE'); meals.reload() })}>Delete</button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Last 7 days">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ash"><tr><th className="pb-2 font-medium">Day</th><th className="text-right font-medium">Calories</th><th className="text-right font-medium">Protein</th></tr></thead>
            <tbody className="divide-y divide-iron-800 font-mono">
              {week.map((d) => {
                const ms = all.filter((m) => m.day === d)
                return (
                  <tr key={d}>
                    <td className="py-1.5 font-sans">{new Date(`${d}T12:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</td>
                    <td className="text-right">{ms.length ? sum(ms, 'kcal') : '—'}</td>
                    <td className={`text-right ${ms.length && sum(ms, 'protein_g') >= protein ? 'text-sage' : ''}`}>{ms.length ? `${sum(ms, 'protein_g')} g` : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      </div>
      <div className="space-y-5">
        <Card title="Add food">
          <form onSubmit={add} className="grid grid-cols-2 gap-3">
            <div className="col-span-2"><Field label="What"><input required maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Chicken rice bowl" /></Field></div>
            <Field label="Calories (kcal)"><input type="number" min={0} max={5000} inputMode="numeric" value={f.kcal} onChange={(e) => setF({ ...f, kcal: e.target.value })} /></Field>
            <Field label="Protein (g)"><input type="number" min={0} max={400} step={0.5} inputMode="decimal" value={f.protein} onChange={(e) => setF({ ...f, protein: e.target.value })} /></Field>
            <Button className="col-span-2" busy={busy === 'add'} disabled={!f.name.trim() || (!f.kcal && !f.protein)}>Add</Button>
          </form>
        </Card>
        <Card title="Calorie target">
          <form onSubmit={saveTarget} className="flex items-end gap-3">
            <div className="flex-1"><Field label="kcal per day (blank = none)"><input type="number" min={800} max={6000} value={target} onChange={(e) => setTarget(e.target.value)} /></Field></div>
            <Button variant="ghost" busy={busy === 'target'}>Save</Button>
          </form>
        </Card>
        {err && <Alert tone="error">{err}</Alert>}
      </div>
    </div>
  )
}
