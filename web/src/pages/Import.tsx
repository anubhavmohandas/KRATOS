import { useState, type FormEvent } from 'react'
import { api, LABELS, useApi, useCatalog, type Plan } from '../api'
import { Alert, Button, Card } from '../ui'
import { navigate } from '../router'

type Row = {
  raw: string; name: string; exercise_id: string | null; confidence: number; sets: number; rep_min: number; rep_max: number
  unit: 'reps' | 'sec'; rest_seconds: number; usable: boolean; swap: string | null
}
type Day = { name: string; items: Row[] }

export default function Import() {
  const health = useApi<{ ai: boolean }>('/health')
  const catalog = useCatalog()
  const [file, setFile] = useState<File | null>(null)
  const [useAi, setUseAi] = useState(false)
  const [days, setDays] = useState<Day[] | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const exercises = Object.values(catalog).sort((a, b) => a.name.localeCompare(b.name))

  async function upload(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    setBusy(true)
    setErr('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('use_ai', String(useAi))
      const r = await api.send<{ days: Day[]; warnings: string[] }>('/imports/pdf', 'POST', fd)
      setDays(r.days)
      setWarnings(r.warnings)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const edit = (d: number, i: number, patch: Partial<Row>) =>
    setDays((all) => all!.map((day, di) => di !== d ? day : { ...day, items: day.items.map((r, ri) => ri !== i ? r : { ...r, ...patch }) }))

  const unresolved = days?.flatMap((d) => d.items).filter((r) => !r.exercise_id).length ?? 0

  async function create() {
    setBusy(true)
    setErr('')
    try {
      const body = {
        days: days!.map((d) => ({
          name: d.name.slice(0, 40), focus: 'imported',
          items: d.items.filter((r) => r.exercise_id).map(({ exercise_id, sets, rep_min, rep_max, unit, rest_seconds }) => ({ exercise_id, sets, rep_min, rep_max: Math.max(rep_min, rep_max), unit, rest_seconds })),
        })).filter((d) => d.items.length),
      }
      await api.send<Plan>('/plans', 'POST', body)
      navigate('/train')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card className="mb-5">
        <form onSubmit={upload} className="flex flex-wrap items-end gap-4">
          <label className="min-w-64 flex-1">
            <span className="mb-1.5 block text-xs font-medium text-ash">Workout PDF (max 10 MB, 40 pages)</span>
            <input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="file:mr-3 file:rounded-md file:border-0 file:bg-iron-700 file:px-3 file:py-1.5 file:text-sm file:text-bone" />
          </label>
          <label className="flex items-center gap-2 pb-2 text-sm" title={health.data?.ai ? '' : 'Set KRATOS_LLM_API_KEY in .env to enable'}>
            <input type="checkbox" checked={useAi} disabled={!health.data?.ai} onChange={(e) => setUseAi(e.target.checked)} />
            <span className={health.data?.ai ? '' : 'text-ash'}>Use AI for messy layouts</span>
          </label>
          <Button busy={busy && !days} disabled={!file}>Extract</Button>
        </form>
        {busy && !days && useAi && <p className="mt-3 text-sm text-ash" role="status">Reading with AI — this can take up to a minute.</p>}
        <p className="mt-3 text-xs text-ash">The PDF is read in memory and discarded. Nothing becomes a plan until you review it below, and it’s saved as a new version — your current plan stays in Train → Versions.{useAi && ' With AI on, the extracted text is sent to your configured LLM provider.'}</p>
      </Card>

      {err && <div className="mb-4"><Alert tone="error">{err}</Alert></div>}
      {warnings.map((w) => <div key={w} className="mb-3"><Alert>{w}</Alert></div>)}

      {days && days.length > 0 && (
        <>
          {days.map((d, di) => (
            <Card key={di} className="mb-4" title={<input aria-label="Day name" value={d.name} maxLength={40} onChange={(e) => setDays(days.map((x, i) => i === di ? { ...x, name: e.target.value } : x))}
              className="!w-auto border-transparent !bg-transparent !px-0 font-display text-base uppercase tracking-wide text-bone" />}>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="text-left text-xs text-ash">
                    <tr><th className="pb-2 font-medium">From PDF</th><th className="font-medium">Matched exercise</th><th className="w-16 font-medium">Sets</th><th className="w-32 font-medium">Reps</th><th className="w-20 font-medium">Rest s</th></tr>
                  </thead>
                  <tbody className="divide-y divide-iron-800 align-top">
                    {d.items.map((r, i) => (
                      <tr key={i}>
                        <td className="max-w-56 py-2 pr-3 text-xs text-ash">{r.raw}</td>
                        <td className="py-2 pr-3">
                          <select aria-label={`Exercise for “${r.name}”`} value={r.exercise_id ?? ''} onChange={(e) => edit(di, i, { exercise_id: e.target.value || null, confidence: 1, usable: true, swap: null })}
                            className={!r.exercise_id ? '!border-ember/60' : r.confidence < 0.85 ? '!border-accent/60' : ''}>
                            <option value="">— skip “{r.name}” —</option>
                            {exercises.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                          </select>
                          {r.exercise_id && r.confidence < 0.85 && <p className="mt-1 text-xs text-accent-hi">Fuzzy match ({Math.round(r.confidence * 100)}%) — check it.</p>}
                          {!r.exercise_id && <p className="mt-1 text-xs text-ember">Not in the library — pick the closest or skip.</p>}
                          {r.exercise_id && !r.usable && (
                            <p className="mt-1 text-xs text-ash">
                              Needs {catalog[r.exercise_id]?.needs.map((n) => LABELS[n]).join(' + ')} or conflicts with a limitation.
                              {r.swap && <> <button type="button" className="font-semibold text-accent hover:underline" onClick={() => edit(di, i, { exercise_id: r.swap, usable: true, swap: null, confidence: 1 })}>Swap for {catalog[r.swap]?.name}</button></>}
                            </p>
                          )}
                        </td>
                        <td className="py-2 pr-3"><input type="number" min={1} max={10} value={r.sets} onChange={(e) => edit(di, i, { sets: +e.target.value })} aria-label="Sets" /></td>
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-1">
                            <input type="number" min={1} max={300} value={r.rep_min} onChange={(e) => edit(di, i, { rep_min: +e.target.value })} aria-label="Min reps" />
                            <span className="text-ash">–</span>
                            <input type="number" min={1} max={300} value={r.rep_max} onChange={(e) => edit(di, i, { rep_max: +e.target.value })} aria-label="Max reps" />
                          </div>
                          {r.unit === 'sec' && <span className="text-xs text-ash">seconds</span>}
                        </td>
                        <td className="py-2"><input type="number" min={0} max={600} step={15} value={r.rest_seconds} onChange={(e) => edit(di, i, { rest_seconds: +e.target.value })} aria-label="Rest seconds" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
          <div className="flex flex-wrap items-center gap-4">
            <Button busy={busy} onClick={create}>Create plan from import</Button>
            {unresolved > 0 && <span className="text-sm text-ash">{unresolved} unmatched row{unresolved > 1 ? 's' : ''} will be skipped.</span>}
          </div>
        </>
      )}
    </>
  )
}
