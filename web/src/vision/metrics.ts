// Pure pose math — no MediaPipe import so it runs under `node --test`.
// Landmark indices: https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker#pose_landmarker_model

export type Lm = { x: number; y: number; z?: number; visibility?: number }
type Pt = { x: number; y: number }
type Triple = [number, number, number]

const deg = (r: number) => (r * 180) / Math.PI
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const vis = (lm: Lm[], idx: number[]) => idx.reduce((s, i) => s + (lm[i]?.visibility ?? 0), 0) / idx.length

/** Interior angle at b, in degrees. */
export function angle(a: Pt, b: Pt, c: Pt): number {
  const r = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x)
  const d = Math.abs(deg(r))
  return d > 180 ? 360 - d : d
}

// ---- rep counting -------------------------------------------------------------

/** A rep = leave the start zone, reach the end zone, come back. `start` says which end of the angle range you start at. */
export type RepProfile = { joints: [Triple, Triple]; start: 'high' | 'low'; lo: number; hi: number; label: string }

const ELBOWS: [Triple, Triple] = [[11, 13, 15], [12, 14, 16]]
const KNEES: [Triple, Triple] = [[23, 25, 27], [24, 26, 28]]
const HIPS: [Triple, Triple] = [[11, 23, 25], [12, 24, 26]]

// occam: fixed thresholds from typical ranges — tune here if your camera angle reads differently.
export const PROFILES: Record<string, RepProfile> = {
  squat: { joints: KNEES, start: 'high', hi: 160, lo: 105, label: 'knee' },
  hinge: { joints: HIPS, start: 'high', hi: 160, lo: 125, label: 'hip' },
  bridge: { joints: HIPS, start: 'low', lo: 145, hi: 165, label: 'hip' },
  pushup: { joints: ELBOWS, start: 'high', hi: 150, lo: 100, label: 'elbow' },
  press: { joints: ELBOWS, start: 'low', lo: 100, hi: 150, label: 'elbow' },
  curl: { joints: ELBOWS, start: 'high', hi: 140, lo: 65, label: 'elbow' },
  row: { joints: ELBOWS, start: 'high', hi: 140, lo: 100, label: 'elbow' },
  pullup: { joints: ELBOWS, start: 'high', hi: 145, lo: 95, label: 'elbow' },
  triceps: { joints: ELBOWS, start: 'low', lo: 80, hi: 145, label: 'elbow' },
  dip: { joints: ELBOWS, start: 'high', hi: 150, lo: 105, label: 'elbow' },
}

export type CounterState = { reps: number; angle: number | null; phase: 'idle' | 'start' | 'end'; cue: string; visible: boolean }

/** `aspect` = video width / height; MediaPipe normalises x and y separately, so x must be rescaled before measuring angles. */
export function createCounter(p: RepProfile, aspect = 16 / 9) {
  let phase: CounterState['phase'] = 'idle'
  let reps = 0
  let smooth: number | null = null
  let excursion = 0
  let cue = 'Get into the start position'

  return (lm: Lm[]): CounterState => {
    const side = p.joints.map((j) => ({ j, v: vis(lm, j) })).sort((a, b) => b.v - a.v)[0]
    if (!lm.length || side.v < 0.5) return { reps, angle: smooth, phase, cue: 'Step back so your whole body is in frame', visible: false }
    const [a, b, c] = side.j.map((i) => ({ x: lm[i].x * aspect, y: lm[i].y }))
    smooth = smooth === null ? angle(a, b, c) : smooth * 0.6 + angle(a, b, c) * 0.4
    const atStart = p.start === 'high' ? smooth >= p.hi : smooth <= p.lo
    const atEnd = p.start === 'high' ? smooth <= p.lo : smooth >= p.hi
    const depth = p.start === 'high' ? p.hi - smooth : smooth - p.lo

    if (phase === 'idle' && atStart) {
      phase = 'start'
      cue = 'Go'
    } else if (phase === 'start') {
      if (atEnd) {
        phase = 'end'
        cue = 'Now back up'
      } else if (atStart) {
        if (excursion > 20) cue = 'Partial rep — use the full range'
        excursion = 0
      } else excursion = Math.max(excursion, depth)
    } else if (phase === 'end' && atStart) {
      phase = 'start'
      reps += 1
      excursion = 0
      cue = 'Good rep'
    }
    return { reps, angle: smooth, phase, cue, visible: true }
  }
}

// ---- body assessment ------------------------------------------------------------

const EYE_HEIGHT = 0.936 // eye level as a fraction of stature (adult anthropometric average)

export const FRONT_POINTS = [2, 5, 11, 12, 23, 24, 25, 26, 27, 28, 29, 30]

/** Front view. Linear widths are calibrated from the user's real height — estimates, not tape measurements. */
export function frontMetrics(lm: Lm[], w: number, h: number, heightCm: number) {
  const P = (i: number) => ({ x: lm[i].x * w, y: lm[i].y * h })
  const [ls, rs, lh, rh] = [P(11), P(12), P(23), P(24)]
  const shoulder = dist(ls, rs)
  const hip = dist(lh, rh)
  const torso = dist(mid(ls, rs), mid(lh, rh))
  const leg = (dist(lh, P(25)) + dist(P(25), P(27)) + dist(rh, P(26)) + dist(P(26), P(28))) / 2
  const stature = ((P(29).y + P(30).y) / 2 - (P(2).y + P(5).y) / 2) / EYE_HEIGHT
  const cmPerPx = heightCm / stature
  // Image x runs opposite to the subject's left/right; abs() keeps the sign meaning "left side lower" either way.
  const tilt = (l: Pt, r: Pt) => deg(Math.atan2(l.y - r.y, Math.abs(l.x - r.x)))
  return {
    shoulder_hip_ratio: shoulder / hip,
    leg_torso_ratio: leg / torso,
    shoulder_width_cm_est: shoulder * cmPerPx,
    hip_width_cm_est: hip * cmPerPx,
    shoulder_tilt_deg: tilt(ls, rs),
    hip_tilt_deg: tilt(lh, rh),
    landmark_quality: vis(lm, FRONT_POINTS),
  }
}

/** Side view. Positive head_forward_ratio = ear ahead of the shoulder, as a fraction of torso length. */
export function sideMetrics(lm: Lm[], w: number, h: number) {
  const left = vis(lm, [7, 11, 23]) >= vis(lm, [8, 12, 24])
  const [ear, sh, hp] = (left ? [7, 11, 23] : [8, 12, 24]).map((i) => ({ x: lm[i].x * w, y: lm[i].y * h }))
  const facing = Math.sign(lm[0].x * w - ear.x) || 1 // nose is ahead of the ear
  return {
    head_forward_ratio: ((ear.x - sh.x) * facing) / dist(sh, hp),
    landmark_quality: vis(lm, left ? [0, 7, 11, 23] : [0, 8, 12, 24]),
  }
}

/** Horizontal shoulder span ÷ torso length: ~0.7 facing the camera, under ~0.3 side-on. */
export function shoulderSpan(lm: Lm[], w: number, h: number) {
  const P = (i: number) => ({ x: lm[i].x * w, y: lm[i].y * h })
  return Math.abs(P(11).x - P(12).x) / Math.max(1e-6, dist(mid(P(11), P(12)), mid(P(23), P(24))))
}

// ---- scan positioning -----------------------------------------------------------

const FACE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
const FEET_L = [27, 29, 31]
const FEET_R = [28, 30, 32]
const EDGE = 0.03 // frame kept clear above the head and below the feet

/**
 * The one instruction that gets the person into a measurable position, or null once they're there.
 * Directions are the person's own: the preview is mirrored, landmarks are raw image coordinates.
 */
export function positionCue(lm: Lm[], view: 'front' | 'side', w: number, h: number): string | null {
  if (!lm.length) return 'Step into frame'
  const face = Math.min(...FACE.map((i) => lm[i].y))
  const shoulderY = (lm[11].y + lm[12].y) / 2
  const top = face - 0.4 * (shoulderY - face) // occam: crown ≈ 40% of face-to-shoulder above the eyes — only gates framing
  const bottom = Math.max(...[...FEET_L, ...FEET_R].map((i) => lm[i].y))
  const span = bottom - top
  if (top < EDGE || bottom > 1 - EDGE) {
    if ((top < EDGE && bottom > 1 - EDGE) || span > 1 - 2 * EDGE) return 'Step back'
    return top < EDGE ? 'Aim the camera higher' : 'Aim the camera lower'
  }
  if (Math.max(vis(lm, FEET_L), vis(lm, FEET_R)) < 0.5) return 'Make sure your feet are visible'
  if (span < 0.6) return 'Come closer'
  const cx = (lm[11].x + lm[12].x + lm[23].x + lm[24].x) / 4
  if (cx > 0.62) return 'Step to your right' // stepping to your right moves you left in the raw image
  if (cx < 0.38) return 'Step to your left'

  const sideOn = shoulderSpan(lm, w, h)
  if (view === 'side') return sideOn < 0.3 ? null : 'Turn sideways'
  if (sideOn <= 0.45) {
    const dz = (lm[11].z ?? 0) - (lm[12].z ?? 0) // smaller z = closer; left shoulder forward means you've turned right
    return dz < -0.05 ? 'Turn a little to your left' : dz > 0.05 ? 'Turn a little to your right' : 'Face the camera'
  }
  const out = Math.sign(lm[23].x - lm[24].x) // +1 when the subject's left is image-right (facing the camera)
  const gap = Math.min((lm[15].x - lm[23].x) * out, (lm[24].x - lm[16].x) * out) * w
  if (gap < 0.15 * Math.abs(lm[11].x - lm[12].x) * w) return 'Arms a little away from your sides'
  if (Math.min(lm[15].y, lm[16].y) < shoulderY) return 'Lower your arms a little'
  return null
}

/** Per-key median over captured frames — kills single-frame jitter. */
export function median<T extends Record<string, number>>(frames: T[]): T {
  const out = {} as Record<string, number>
  for (const k of Object.keys(frames[0] ?? {})) {
    const v = frames.map((f) => f[k]).sort((a, b) => a - b)
    out[k] = v[Math.floor(v.length / 2)]
  }
  return out as T
}
