import { useEffect, useState } from 'react'

export type Units = 'kg' | 'lb'
export type Profile = {
  age: number
  height_cm: number
  weight_kg: number
  experience: 'beginner' | 'intermediate' | 'advanced'
  goal: 'muscle_gain' | 'strength' | 'fat_loss' | 'general' | 'endurance'
  days_per_week: number
  session_minutes: number
  limitations: string[]
  location: 'home' | 'gym'
  units: Units
}
export type Equipment = { id: number; type: string; weights_kg: number[] }
export type Exercise = {
  id: string
  name: string
  pattern: string
  muscles: string[]
  needs: string[]
  level: number
  load: string | null
  timed?: boolean
  avoid: string[]
  anim: string
  props?: string[]
  track: string | null
  cues: string[]
  mistakes: string[]
}
export type Rx = { load_kg: number | null; reps: number; note: string | null; e1rm?: number; table: { load_kg: number; reps: number }[] }
export type PlanItem = { exercise_id: string; sets: number; rep_min: number; rep_max: number; unit: 'reps' | 'sec'; rest_seconds: number; rx?: Rx }
export type PlanDay = { name: string; focus: string; items: PlanItem[] }
export type Plan = { id: number; version: number; source: string; created_at: string; split: string; days: PlanDay[]; warnings: string[] }
export type SetLog = { id: number; exercise_id: string; set_number: number; load_kg: number; reps: number; rir: number | null }
export type Assessment = { id: number; kind: 'manual' | 'camera'; measured_at: string } & Record<string, number | string>

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch('/api' + path, {
    ...init,
    headers: typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : undefined,
  })
  if (r.status === 401) location.assign('/login') // session expired: the server gates every route
  if (!r.ok) {
    const e = await r.json().catch(() => ({}))
    const detail = typeof e.detail === 'string' ? e.detail : Array.isArray(e.detail) ? e.detail.map((d: { msg: string }) => d.msg).join('; ') : `Request failed (${r.status})`
    throw new ApiError(r.status, detail)
  }
  return r.status === 204 ? (undefined as T) : r.json()
}

export const api = {
  get: <T>(path: string) => req<T>(path),
  send: <T>(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown) =>
    req<T>(path, { method, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) }),
}

/** Fetch once on mount; `reload()` refetches. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(!!path)
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!path) return
    let live = true
    setLoading(true)
    api.get<T>(path)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(e instanceof ApiError ? e : new ApiError(0, 'Can’t reach the KRATOS API — is it running?')))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [path, n])
  return { data, error, loading, reload: () => setN((x) => x + 1), setData }
}

let catalog: Promise<Record<string, Exercise>> | null = null
export function useCatalog() {
  const [map, setMap] = useState<Record<string, Exercise>>({})
  useEffect(() => {
    catalog ??= api.get<Exercise[]>('/exercises').then((list) => Object.fromEntries(list.map((e) => [e.id, e])))
    catalog.then(setMap, () => (catalog = null))
  }, [])
  return map
}

// ---- units: stored in kg, shown in the user's choice ----
const LB = 2.20462
export const toKg = (v: number, u: Units) => (u === 'lb' ? v / LB : v)
export const fromKg = (kg: number, u: Units) => (u === 'lb' ? Math.round(kg * LB * 2) / 2 : Math.round(kg * 100) / 100)
export const fmtLoad = (kg: number | null | undefined, u: Units) => (kg == null ? '—' : kg === 0 ? 'Bodyweight' : `${fromKg(kg, u)} ${u}`)
export const fmtTarget = (i: PlanItem) => `${i.sets} × ${i.rep_min === i.rep_max ? i.rep_min : `${i.rep_min}–${i.rep_max}`}${i.unit === 'sec' ? ' s' : ''}`

export const LABELS: Record<string, string> = {
  muscle_gain: 'Build muscle', strength: 'Get stronger', fat_loss: 'Lose fat', general: 'General fitness', endurance: 'Endurance',
  beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced',
  knee: 'Knee', shoulder: 'Shoulder', lower_back: 'Lower back', wrist: 'Wrist', elbow: 'Elbow',
  dumbbells: 'Dumbbells', kettlebell: 'Kettlebell', barbell: 'Barbell + plates', rack: 'Squat rack', bench: 'Bench',
  pull_up_bar: 'Pull-up bar', dip_bars: 'Dip bars', bands: 'Resistance bands', cable: 'Cable stack',
}

// ---- small shared helpers ----
export const local = {
  get<T>(k: string): T | null {
    try {
      return JSON.parse(localStorage.getItem(k) ?? 'null')
    } catch {
      return null
    }
  },
  set(k: string, v: unknown) {
    try {
      if (v === null) localStorage.removeItem(k)
      else localStorage.setItem(k, JSON.stringify(v))
    } catch { /* storage unavailable — just not remembered */ }
  },
}
export type ActiveSession = { id: number; plan_id: number; day: number }
export const SESSION_KEY = 'kratos.session'

/** The workout in progress: this browser's, else one left unfinished in the last 12 h on any device. */
export function useActiveSession() {
  const [active, setActive] = useState<ActiveSession | null>(() => local.get(SESSION_KEY))
  const set = (a: ActiveSession | null) => {
    local.set(SESSION_KEY, a)
    setActive(a)
  }
  useEffect(() => {
    if (active) return
    let live = true
    api.get<{ id: number; plan_id: number; day_index: number } | null>('/sessions/open')
      .then((s) => { if (live && s) set({ id: s.id, plan_id: s.plan_id, day: s.day_index }) }, () => {})
    return () => { live = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return [active, set] as const
}
export const NEXT_DAY_KEY = 'kratos.nextDay'
/** Same budget the engine uses: 5 min warm-up + sets × (40 s work + rest) + 1 min setup per exercise. */
export const estMinutes = (d: PlanDay) => Math.round((300 + d.items.reduce((s, i) => s + i.sets * (40 + i.rest_seconds) + 60, 0)) / 60)
export const usable = (ex: Exercise, owned: Set<string>, limitations: string[]) =>
  ex.needs.every((n) => owned.has(n)) && !ex.avoid.some((a) => limitations.includes(a))
export const PATTERNS: Record<string, string> = {
  squat: 'Squat', hinge: 'Hinge', lunge: 'Lunge', h_push: 'Push', v_push: 'Overhead', h_pull: 'Row', v_pull: 'Pull-up', core: 'Core', biceps: 'Biceps', triceps: 'Triceps',
}
