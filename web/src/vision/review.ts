// Form review for one camera-counted set, built only from the rep counter's own verdicts: its rep count and cues.

export type RepEvent = { t: number; kind: 'good' | 'rejected' | 'partial'; why?: string }
type Seen = { reps: number; cue: string }

/** A rep counted, or an attempt the counter refused (and why), between two successive counter states. */
export function nextEvent(prev: Seen, s: Seen, t: number): RepEvent | null {
  if (s.reps > prev.reps) return { t, kind: 'good' }
  if (s.cue === prev.cue) return null
  if (s.cue.startsWith('Not counted — ')) return { t, kind: 'rejected', why: s.cue.slice('Not counted — '.length) }
  if (s.cue.startsWith('Partial rep')) return { t, kind: 'partial', why: 'partial range of motion' }
  return null
}

/**
 * Folds the next counter state into the running review. Frames with tracking lost carry a temporary
 * "step back"/"turn side-on" cue and the stored verdict returns after them, so they are skipped entirely.
 */
// occam: two partial reps in a row leave the same cue, so the second isn't seen; a verdict counter in CounterState would fix it.
export function fold(prev: Seen, s: Seen & { visible?: boolean }, t: number): [Seen, RepEvent | null] {
  if (s.visible === false) return [prev, null]
  return [{ reps: s.reps, cue: s.cue }, nextEvent(prev, s, t)]
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

export function review(events: RepEvent[]) {
  const good = events.filter((e) => e.kind === 'good')
  const gaps = good.slice(1).map((e, i) => (e.t - good[i].t) / 1000) // seconds from one counted rep to the next
  const half = Math.floor(gaps.length / 2)
  let tempo: string | null = null
  if (half >= 2) {
    const r = mean(gaps.slice(-half)) / mean(gaps.slice(0, half))
    tempo = r > 1.25 ? 'Reps slowed towards the end: you were close to your limit.'
      : r < 0.8 ? 'Reps sped up towards the end: keep the lowering controlled.'
        : 'Steady tempo throughout.'
  }
  const why = new Map<string, number>()
  for (const e of events) if (e.kind !== 'good') why.set(e.why ?? '', (why.get(e.why ?? '') ?? 0) + 1)
  return {
    counted: good.length,
    rejected: events.length - good.length,
    reasons: [...why].map(([w, n]) => ({ why: w, n })),
    secondsPerRep: gaps.length ? mean(gaps) : null,
    tempo,
  }
}
