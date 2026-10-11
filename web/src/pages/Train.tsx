import { useState } from 'react'
import {
  api, estMinutes, fmtLoad, fmtTarget, LABELS, local, NEXT_DAY_KEY, PATTERNS, usable, useActiveSession, useApi, useCatalog,
  type Equipment, type Plan, type PlanDay, type PlanItem, type Profile, type Units,
} from '../api'
import { Alert, Button, Card, PageHead, Spinner } from '../ui'
import Library from './Library'
import Session from './Session'
import { Link } from '../router'

const TABS = [['', 'Plan'], ['library', 'Exercise library'], ['versions', 'Versions']] as const

export default function Train({ profile, sub }: { profile: Profile; sub: string }) {
  const tab = TABS.some(([k]) => k === sub) ? sub : ''
  return (
    <>
      <nav className="mb-6 flex gap-1 border-b border-iron-800" aria-label="Train sections">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`/train${k && '/' + k}`} aria-current={tab === k ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-accent text-bone' : 'border-transparent text-ash hover:text-bone'}`}>{label}</Link>
        ))}
      </nav>
      {tab === 'library' ? <Library profile={profile} /> : tab === 'versions' ? <Versions /> : <PlanView profile={profile} />}
    </>
  )
}

function PlanView({ profile }: { profile: Profile }) {
  const plan = useApi<Plan>('/plans/active')
  const health = useApi<{ ai: boolean; model: string | null }>('/health')
  const equipment = useApi<Equipment[]>('/equipment')
  const catalog = useCatalog()
  const [active, setActive] = useActiveSession()
  const [day, setDay] = useState(() => local.get<number>(NEXT_DAY_KEY) ?? 0)
  const [busy, setBusy] = useState<'' | 'gen' | 'start' | 'why' | 'save'>('')
  const [err, setErr] = useState('')
  const [why, setWhy] = useState('')
  const [draft, setDraft] = useState<PlanDay[] | null>(null)

  async function run<T>(kind: typeof busy, fn: () => Promise<T>) {
    setBusy(kind)
    setErr('')
    try {
      return await fn()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const generate = () => run('gen', async () => {
    if (plan.data && !confirm('Generate a new plan? The current one stays in Versions; logged workouts are kept.')) return
    plan.setData(await api.send<Plan>('/plans/generate', 'POST'))
    setWhy('')
    setDay(0)
  })
  const start = () => run('start', async () => {
    const s = await api.send<{ id: number }>('/sessions', 'POST', { plan_id: plan.data!.id, day_index: day })
    setActive({ id: s.id, plan_id: plan.data!.id, day })
  })
  const explain = () => run('why', async () => setWhy((await api.send<{ text: string }>(`/plans/${plan.data!.id}/explain`, 'POST')).text))
  const save = () => run('save', async () => {
    const days = draft!.map((d) => ({ name: d.name, focus: d.focus, items: d.items.map(({ rx: _rx, ...i }) => ({ ...i, rep_max: Math.max(i.rep_min, i.rep_max) })) }))
    plan.setData(await api.send<Plan>('/plans', 'POST', { days, split: plan.data!.split, source: 'edited' }))
    setDraft(null)
  })

  /** Leave the workout view; `done` moves on to the next day. */
  function endSession(done: boolean) {
    if (done && active && plan.data) {
      const next = (active.day + 1) % plan.data.days.length
      local.set(NEXT_DAY_KEY, next)
      setDay(next)
    }
    setActive(null)
    plan.reload()
  }

  if (plan.loading) return <Spinner />
  if (active && plan.data?.id === active.plan_id) {
    return <Session plan={plan.data} dayIndex={active.day} sessionId={active.id} units={profile.units} onExit={endSession} />
  }
  if (active && plan.data && plan.data.id !== active.plan_id) setActive(null) // that plan was replaced — the session can't resume
  if (plan.error && plan.error.status !== 404) return <Alert tone="error">{plan.error.message}</Alert>

  if (!plan.data) {
    return (
      <>
        <PageHead kicker="Train" title="Build your plan" />
        <Card>
          <p className="max-w-xl text-ash">
            {profile.days_per_week} days a week, {profile.session_minutes} minutes, goal: <span className="text-bone">{LABELS[profile.goal].toLowerCase()}</span>.
            KRATOS picks exercises your equipment supports, sets reps for your goal, and calibrates loads from the sets you log.
          </p>
          {err && <div className="mt-4"><Alert tone="error">{err}</Alert></div>}
          <Button className="mt-5" busy={busy === 'gen'} onClick={generate}>Generate my plan</Button>
          <p className="mt-3 text-xs text-ash">Have a plan from a coach? <Link href="/space/pdf" className="text-accent hover:underline">Import a PDF</Link> instead.</p>
        </Card>
      </>
    )
  }

  const p = plan.data
  const di = Math.min(day, p.days.length - 1)
  const d = draft ? draft[di] : p.days[di]
  const owned = new Set((equipment.data ?? []).map((e) => e.type))
  const options = Object.values(catalog).filter((e) => usable(e, owned, profile.limitations)).sort((a, b) => a.name.localeCompare(b.name))
  const editItem = (i: number, patch: Partial<PlanItem>) =>
    setDraft(draft!.map((x, j) => (j !== di ? x : { ...x, items: x.items.map((it, k) => (k === i ? { ...it, ...patch, rx: undefined } : it)) })))

  return (
    <>
      <PageHead kicker={`Plan v${p.version} · ${p.split}${p.source !== 'engine' ? ` · ${p.source}` : ''}`} title={d.name}>
        <div className="flex flex-wrap gap-2">
          {draft ? (
            <>
              <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
              <Button busy={busy === 'save'} onClick={save} disabled={draft.some((x) => !x.items.length)}>Save as v{p.version + 1}</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={explain} busy={busy === 'why'} disabled={!health.data?.ai}
                title={health.data?.ai ? `Ask ${health.data.model}` : 'Set KRATOS_LLM_API_KEY in .env to enable'}>Why this plan?</Button>
              <Button variant="ghost" onClick={() => setDraft(structuredClone(p.days))}>Edit plan</Button>
              <Button variant="ghost" onClick={generate} busy={busy === 'gen'}>Regenerate</Button>
            </>
          )}
        </div>
      </PageHead>

      <div className="mb-5 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Plan days">
        {(draft ?? p.days).map((x, i) => (
          <button key={i} role="tab" aria-selected={i === di} onClick={() => setDay(i)}
            className={`shrink-0 rounded-lg border px-4 py-2 text-left transition-colors ${i === di ? 'border-accent bg-accent/10' : 'border-iron-700 hover:border-iron-600'}`}>
            <div className="font-mono text-[11px] text-ash">DAY {String(i + 1).padStart(2, '0')} · ~{estMinutes(x)} MIN</div>
            <div className="font-display text-sm font-semibold uppercase tracking-wide">{x.name}</div>
          </button>
        ))}
      </div>

      {err && <div className="mb-4"><Alert tone="error">{err}</Alert></div>}
      {draft && <div className="mb-4"><Alert>Editing a copy. Saving creates v{p.version + 1}; v{p.version} stays in Versions. Swaps only offer exercises your equipment and limitations allow.</Alert></div>}
      {!draft && p.warnings.map((w) => <div key={w} className="mb-3"><Alert>{w}</Alert></div>)}
      {busy === 'why' && <p className="mb-5 text-sm text-ash" role="status">Asking the AI — this can take up to a minute.</p>}
      {why && !draft && <Card title="Coach’s notes" className="mb-5"><p className="whitespace-pre-line text-sm leading-relaxed text-bone/90">{why}</p></Card>}

      {draft ? (
        <ol className="space-y-3">
          {d.items.map((it, i) => {
            const pattern = catalog[it.exercise_id]?.pattern
            const swaps = options.filter((e) => e.pattern === pattern || e.id === it.exercise_id)
            if (!swaps.some((e) => e.id === it.exercise_id) && catalog[it.exercise_id]) swaps.unshift(catalog[it.exercise_id])
            return (
              <li key={i} className="grid grid-cols-2 gap-3 rounded-xl border border-iron-700 bg-iron-900 p-4 sm:grid-cols-[1fr_auto_auto_auto_auto_auto] sm:items-end">
                <label className="col-span-2 sm:col-span-1"><span className="mb-1 block text-xs text-ash">Exercise ({PATTERNS[pattern] ?? '—'})</span>
                  <select value={it.exercise_id} onChange={(e) => editItem(i, { exercise_id: e.target.value })}>{swaps.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select>
                </label>
                {(['sets', 'rep_min', 'rep_max', 'rest_seconds'] as const).map((k) => (
                  <label key={k} className="sm:w-20"><span className="mb-1 block text-xs text-ash">{{ sets: 'Sets', rep_min: it.unit === 'sec' ? 'Min s' : 'Min reps', rep_max: it.unit === 'sec' ? 'Max s' : 'Max reps', rest_seconds: 'Rest s' }[k]}</span>
                    <input type="number" min={k === 'rest_seconds' ? 0 : 1} max={k === 'sets' ? 10 : k === 'rest_seconds' ? 600 : 300} value={it[k]} onChange={(e) => editItem(i, { [k]: +e.target.value })} />
                  </label>
                ))}
                <Button variant="danger" className="col-span-2 sm:col-span-1" onClick={() => setDraft(draft.map((x, j) => (j !== di ? x : { ...x, items: x.items.filter((_, k) => k !== i) })))}>Remove</Button>
              </li>
            )
          })}
          <li>
            <select aria-label="Add exercise" value="" className="!w-auto" onChange={(e) => {
              const ex = catalog[e.target.value]
              if (!ex) return
              const item: PlanItem = { exercise_id: ex.id, sets: 3, rep_min: ex.timed ? 30 : 8, rep_max: ex.timed ? 45 : 12, unit: ex.timed ? 'sec' : 'reps', rest_seconds: 90 }
              setDraft(draft.map((x, j) => (j !== di ? x : { ...x, items: [...x.items, item].slice(0, 15) })))
            }}>
              <option value="">+ Add exercise…</option>
              {options.filter((e) => !d.items.some((i) => i.exercise_id === e.id)).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </li>
        </ol>
      ) : (
        <ol className="space-y-3">
          {d.items.map((it, i) => <ExerciseRow key={it.exercise_id} item={it} n={i + 1} units={profile.units} />)}
        </ol>
      )}

      {!draft && (
        <div className="sticky bottom-36 mt-6 flex justify-end pr-16 lg:bottom-6 lg:pr-20">
          <Button className="px-8 py-3 text-base shadow-2xl shadow-black" busy={busy === 'start'} onClick={start}>Start {d.name}</Button>
        </div>
      )}
    </>
  )
}

function ExerciseRow({ item, n, units }: { item: PlanItem; n: number; units: Units }) {
  const ex = useCatalog()[item.exercise_id]
  const [open, setOpen] = useState(false)
  const rx = item.rx
  return (
    <li className="rounded-xl border border-iron-700 bg-iron-900 p-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <span className="font-mono text-sm text-ash">{String(n).padStart(2, '0')}</span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{ex?.name ?? item.exercise_id}</h3>
          <p className="text-xs text-ash">{ex?.muscles.join(' · ')}</p>
        </div>
        <div className="text-right">
          <div className="font-mono text-lg font-bold">{fmtTarget(item)}</div>
          <div className="text-xs text-ash">
            {rx?.load_kg != null ? <span className="text-accent">{fmtLoad(rx.load_kg, units)} × {rx.reps}</span> : ex?.load ? 'load: calibrate' : 'bodyweight'} · rest {item.rest_seconds}s
          </div>
        </div>
      </div>
      {rx?.note && <p className="mt-3 border-l-2 border-accent/60 pl-3 text-sm text-ash">{rx.note}</p>}
      {rx && rx.table.length > 0 && (
        <div className="mt-3">
          <button className="text-xs font-semibold text-accent hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Show'} reps you can likely do with each weight
          </button>
          {open && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {rx.table.map((t) => (
                <span key={t.load_kg} className={`rounded-md border px-2 py-1 font-mono text-xs ${t.load_kg === rx.load_kg ? 'border-accent text-accent' : 'border-iron-700 text-ash'}`}>
                  {fmtLoad(t.load_kg, units)} → ~{t.reps}
                </span>
              ))}
              <span className="w-full text-[11px] text-ash/80">Reps to failure, estimated from your best recent set (e1RM {fmtLoad(rx.e1rm, units)}). Prescriptions leave ~2 in reserve.</span>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function Versions() {
  const list = useApi<{ id: number; version: number; source: string; status: string; created_at: string; split: string; days: string[] }[]>('/plans')
  const [err, setErr] = useState('')
  if (list.loading) return <Spinner />
  if (!list.data?.length) return <p className="text-sm text-ash">No plans yet.</p>
  return (
    <>
      <PageHead kicker="Train" title="Plan versions" />
      {err && <div className="mb-4"><Alert tone="error">{err}</Alert></div>}
      <ol className="space-y-2">
        {list.data.map((v) => (
          <li key={v.id} className={`flex flex-wrap items-center gap-4 rounded-xl border p-4 ${v.status === 'active' ? 'border-accent/60 bg-accent/5' : 'border-iron-700 bg-iron-900'}`}>
            <span className="font-mono text-lg font-bold">v{v.version}</span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">{v.split} <span className="ml-2 text-xs uppercase tracking-wider text-ash">{{ engine: 'generated', import: 'from PDF', edited: 'edited' }[v.source] ?? v.source}</span></div>
              <div className="truncate text-xs text-ash">{new Date(v.created_at).toLocaleString()} · {v.days.join(' · ')}</div>
            </div>
            {v.status === 'active' ? <span className="text-sm font-semibold text-accent">Active</span> : (
              <Button variant="ghost" onClick={async () => {
                try {
                  await api.send(`/plans/${v.id}/activate`, 'POST')
                  local.set(NEXT_DAY_KEY, 0)
                  list.reload()
                } catch (e) { setErr((e as Error).message) }
              }}>Make active</Button>
            )}
          </li>
        ))}
      </ol>
    </>
  )
}
