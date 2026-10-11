import { useEffect, useRef, useState } from 'react'
import type { CounterState } from './metrics'
import { fold, review, type RepEvent } from './review'

/** Live form summary under the rep counter: what counted, what didn't and why, and how the tempo held up. */
export default function FormReview({ s }: { s: CounterState | null }) {
  const prev = useRef({ reps: 0, cue: '' })
  const [events, setEvents] = useState<RepEvent[]>([])
  useEffect(() => {
    if (!s) { // counter reset
      prev.current = { reps: 0, cue: '' }
      setEvents([])
      return
    }
    const [next, e] = fold(prev.current, s, performance.now())
    prev.current = next
    if (e) setEvents((x) => [...x, e])
  }, [s])
  if (!events.length) return null
  const r = review(events)
  return (
    <section className="rounded-xl border border-iron-700 bg-iron-900 p-4 text-sm" aria-label="Form review">
      <h3 className="mb-2 font-display text-xs font-semibold uppercase tracking-[0.14em] text-ash">Form review</h3>
      <p>
        <span className="text-sage">{r.counted} counted</span>
        {r.rejected > 0 && <> · <span className="text-ember">{r.rejected} not counted</span></>}
        {r.secondsPerRep != null && <span className="text-ash"> · ~{r.secondsPerRep.toFixed(1)} s per rep</span>}
      </p>
      {r.reasons.length > 0 && <ul className="mt-1 list-disc pl-5 text-ash">{r.reasons.map((x) => <li key={x.why}>{x.why}{x.n > 1 && ` ×${x.n}`}</li>)}</ul>}
      {r.tempo && <p className="mt-1 text-ash">{r.tempo}</p>}
    </section>
  )
}
