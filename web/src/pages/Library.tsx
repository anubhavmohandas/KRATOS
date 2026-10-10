import { lazy, Suspense, useState } from 'react'
import { LABELS, PATTERNS, usable, useApi, useCatalog, type Equipment, type Profile } from '../api'
import { PROFILES } from '../vision/metrics'
import { Card, Chip, PageHead, Spinner } from '../ui'

const Trainer3D = lazy(() => import('../trainer/Trainer3D'))  // keeps three.js out of the main bundle

const LEVELS = ['', 'Beginner', 'Intermediate', 'Advanced']

export default function Library({ profile }: { profile: Profile }) {
  const catalog = useCatalog()
  const equipment = useApi<Equipment[]>('/equipment')
  const [pattern, setPattern] = useState('')
  const [mine, setMine] = useState(true)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState('')
  const owned = new Set((equipment.data ?? []).map((e) => e.type))
  const list = Object.values(catalog)
    .filter((e) => (!pattern || e.pattern === pattern) && (!mine || usable(e, owned, profile.limitations)) && e.name.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
  const ex = catalog[sel] ?? list[0]

  return (
    <>
      <PageHead kicker="Train" title="Exercise library" />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input type="search" placeholder="Search exercises" aria-label="Search exercises" value={q} onChange={(e) => setQ(e.target.value)} className="!w-56" />
        <Chip on={!pattern} onClick={() => setPattern('')}>All</Chip>
        {Object.entries(PATTERNS).map(([k, v]) => <Chip key={k} on={pattern === k} onClick={() => setPattern(k)}>{v}</Chip>)}
        <label className="ml-auto flex items-center gap-2 text-sm text-ash"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only what my gear allows</label>
      </div>

      <div className="grid gap-5 lg:grid-cols-[340px_1fr]">
        <ul className="max-h-[70vh] space-y-1 overflow-y-auto pr-1" aria-label="Exercises">
          {list.map((e) => (
            <li key={e.id}>
              <button onClick={() => setSel(e.id)} aria-current={ex?.id === e.id || undefined}
                className={`flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left ${ex?.id === e.id ? 'border-accent bg-accent/10' : 'border-iron-800 bg-iron-900 hover:border-iron-600'}`}>
                <span>
                  <span className="block text-sm font-medium">{e.name}</span>
                  <span className="block text-xs text-ash">{PATTERNS[e.pattern]} · {e.needs.length ? e.needs.map((n) => LABELS[n]).join(' + ') : 'No equipment'}</span>
                </span>
                {!usable(e, owned, profile.limitations) && <span className="shrink-0 text-[10px] uppercase tracking-wider text-ash">n/a</span>}
              </button>
            </li>
          ))}
          {!list.length && <li className="p-4 text-sm text-ash">Nothing matches.</li>}
        </ul>

        {ex && (
          <div className="space-y-4">
            <div className="h-80 sm:h-[26rem]"><Suspense fallback={<Spinner />}><Trainer3D anim={ex.anim} props={ex.props} label={ex.name} /></Suspense></div>
            <Card title={ex.name}>
              <dl className="mb-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div><dt className="text-xs text-ash">Muscles</dt><dd>{ex.muscles.join(', ')}</dd></div>
                <div><dt className="text-xs text-ash">Equipment</dt><dd>{ex.needs.length ? ex.needs.map((n) => LABELS[n]).join(', ') : 'None'}</dd></div>
                <div><dt className="text-xs text-ash">Level</dt><dd>{LEVELS[ex.level]}</dd></div>
                <div><dt className="text-xs text-ash">Camera rep count</dt><dd>{ex.track && PROFILES[ex.track] ? 'Supported' : '—'}</dd></div>
              </dl>
              {ex.avoid.length > 0 && <p className="mb-4 text-xs text-ash">Left out of plans for: {ex.avoid.map((a) => LABELS[a].toLowerCase()).join(', ')} limitations.</p>}
              <div className="grid gap-4 sm:grid-cols-2">
                <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-accent">Cues</h3><ul className="list-disc space-y-1 pl-4 text-sm">{ex.cues.map((c) => <li key={c}>{c}</li>)}</ul></div>
                <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ember">Avoid</h3><ul className="list-disc space-y-1 pl-4 text-sm text-ash">{ex.mistakes.map((c) => <li key={c}>{c}</li>)}</ul></div>
              </div>
            </Card>
          </div>
        )}
      </div>
    </>
  )
}
