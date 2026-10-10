import { test } from 'node:test'
import assert from 'node:assert/strict'
import { angle, createCounter, frontMetrics, median, PROFILES, shoulderSpan, type Lm } from './metrics.ts'

/** 33 landmarks with the left knee (23-25-27) bent to `deg` and everything visible. */
function kneeAt(deg: number, visibility = 1): Lm[] {
  const lm: Lm[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0.1 }))
  const r = (deg * Math.PI) / 180
  lm[25] = { x: 0.5, y: 0.6, visibility } // knee
  lm[27] = { x: 0.5, y: 0.8, visibility } // ankle straight below
  lm[23] = { x: 0.5 + 0.2 * Math.sin(r), y: 0.6 + 0.2 * Math.cos(r), visibility } // hip at `deg` from the shin
  return lm
}

const run = (angles: number[], vis = 1) => {
  const count = createCounter(PROFILES.squat, 1)
  return angles.map((a) => count(kneeAt(a, vis))).at(-1)!
}
const hold = (a: number, n = 6) => Array(n).fill(a)

test('angle', () => {
  assert.equal(Math.round(angle({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 })), 90)
  assert.equal(Math.round(angle({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })), 180)
  const k = kneeAt(120)
  assert.equal(Math.round(angle(k[23], k[25], k[27])), 120)
})

test('counts full reps only', () => {
  const s = run([...hold(175), ...hold(90), ...hold(175), ...hold(90), ...hold(175)])
  assert.equal(s.reps, 2)
  assert.equal(s.cue, 'Good rep')
})

test('partial rep is not counted and gets a cue', () => {
  const s = run([...hold(175), ...hold(130), ...hold(175)])
  assert.equal(s.reps, 0)
  assert.match(s.cue, /Partial/)
})

test('jitter around one threshold never double counts', () => {
  const s = run([...hold(175), ...hold(90), 112, 98, 113, 99, 111, ...hold(175)])
  assert.equal(s.reps, 1)
})

test('no reps before the start position, none while landmarks are hidden', () => {
  assert.equal(run([...hold(90), ...hold(175)]).reps, 0) // walked in already squatting
  const hidden = run([...hold(175), ...hold(90), ...hold(175)], 0.2)
  assert.equal(hidden.reps, 0)
  assert.equal(hidden.visible, false)
})

test('front metrics on a symmetric figure', () => {
  const lm: Lm[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }))
  const set = (i: number, x: number, y: number) => (lm[i] = { x, y, visibility: 1 })
  set(2, 0.48, 0.1); set(5, 0.52, 0.1) // eyes
  set(11, 0.6, 0.2); set(12, 0.4, 0.2) // shoulders 0.2 apart
  set(23, 0.55, 0.5); set(24, 0.45, 0.5) // hips 0.1 apart
  set(25, 0.55, 0.7); set(26, 0.45, 0.7); set(27, 0.55, 0.9); set(28, 0.45, 0.9)
  set(29, 0.55, 0.1 + 0.8 * 0.936); set(30, 0.45, 0.1 + 0.8 * 0.936) // heels → stature 0.8 of frame
  const m = frontMetrics(lm, 1000, 1000, 180)
  assert.equal(m.shoulder_hip_ratio.toFixed(2), '2.00')
  assert.equal(m.shoulder_tilt_deg, 0)
  assert.equal(m.shoulder_width_cm_est.toFixed(1), '45.0') // 200px × 180cm / 800px
  assert.equal(m.leg_torso_ratio.toFixed(2), (0.4 / 0.3).toFixed(2))
  assert.equal(shoulderSpan(lm, 1000, 1000).toFixed(2), '0.67') // facing: 200px span / 300px torso
  set(11, 0.51, 0.2); set(12, 0.49, 0.2) // turned side-on: shoulders overlap
  assert.ok(shoulderSpan(lm, 1000, 1000) < 0.3)
})

test('median per key', () => {
  assert.deepEqual(median([{ a: 1 }, { a: 9 }, { a: 3 }]), { a: 3 })
})
