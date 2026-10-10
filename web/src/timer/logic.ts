// Timer state is pure math over wall-clock timestamps, so it stays right when the tab is
// backgrounded or the phone sleeps — nothing counts interval ticks.

export type TimerCfg =
  | { kind: 'countdown'; seconds: number; label: string }
  | { kind: 'stopwatch'; label: string }
  | { kind: 'intervals'; work: number; rest: number; rounds: number; prepare: number; label: string }

export type TimerRun = { cfg: TimerCfg; startedAt: number; pausedAt: number | null; pausedMs: number }

export type Phase = 'prepare' | 'work' | 'rest' | 'run' | 'done'
export type View = { phase: Phase; round: number; rounds: number; remaining: number; elapsed: number; phaseLen: number }

export const elapsedMs = (r: TimerRun, now: number) => Math.max(0, (r.pausedAt ?? now) - r.startedAt - r.pausedMs)

export const start = (cfg: TimerCfg, now: number): TimerRun => ({ cfg, startedAt: now, pausedAt: null, pausedMs: 0 })
export const pause = (r: TimerRun, now: number): TimerRun => (r.pausedAt ? r : { ...r, pausedAt: now })
export const resume = (r: TimerRun, now: number): TimerRun => (r.pausedAt ? { ...r, pausedAt: null, pausedMs: r.pausedMs + now - r.pausedAt } : r)

export function view(cfg: TimerCfg, ms: number): View {
  const base = { round: 1, rounds: 1, elapsed: ms }
  if (cfg.kind === 'stopwatch') return { ...base, phase: 'run', remaining: Infinity, phaseLen: 0 }
  if (cfg.kind === 'countdown') {
    const len = cfg.seconds * 1000
    return { ...base, phase: ms >= len ? 'done' : 'work', remaining: Math.max(0, len - ms), phaseLen: len }
  }
  // intervals: prepare, then work/rest × rounds — no rest after the last round
  const { rounds } = cfg
  const [p, w, r] = [cfg.prepare * 1000, cfg.work * 1000, cfg.rest * 1000]
  if (ms < p) return { ...base, rounds, phase: 'prepare', remaining: p - ms, phaseLen: p }
  let t = ms - p
  for (let round = 1; round <= rounds; round++) {
    if (t < w) return { ...base, round, rounds, phase: 'work', remaining: w - t, phaseLen: w }
    t -= w
    if (round === rounds) break
    if (t < r) return { ...base, round, rounds, phase: 'rest', remaining: r - t, phaseLen: r }
    t -= r
  }
  return { ...base, round: rounds, rounds, phase: 'done', remaining: 0, phaseLen: 0 }
}

/** mm:ss — countdowns round up so "0:00" only shows when it's actually over. */
export function fmt(ms: number, up = true) {
  const s = up ? Math.ceil(ms / 1000) : Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const total = (cfg: TimerCfg) =>
  cfg.kind === 'intervals' ? cfg.prepare + cfg.rounds * cfg.work + (cfg.rounds - 1) * cfg.rest : cfg.kind === 'countdown' ? cfg.seconds : 0
