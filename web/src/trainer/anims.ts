import type { Anim, Joint, Pose, V3 } from './mannequin'

// Keyframes in degrees (three.js Euler XYZ). The figure faces +z; its left side is +x.
//   root.x   +90 face-down (head → +z) · −90 face-up (head → −z) · small + = whole body leans forward
//   spine.x  + bends forward            neck.x  − looks up
//   shoulder / hip .x  − swings the limb forward    .z  + swings it out to the side (left; right is mirrored)
//   elbow.x  − bends (forearm forward/up)           elbow.z  + bends in the frontal plane (pressing)
//   knee.x   + bends (shin back)
// A joint missing from a keyframe is neutral (0,0,0) in that keyframe.

type Limbs = { shoulder?: V3; elbow?: V3; hip?: V3; knee?: V3; ankle?: V3 }

/** Symmetric limbs: give the left side, the right side is mirrored. */
function sym(p: Limbs): Pose {
  const out: Pose = {}
  for (const [k, v] of Object.entries(p) as [string, V3][]) {
    out[`${k}L` as Joint] = v
    out[`${k}R` as Joint] = [v[0], -v[1], -v[2]]
  }
  return out
}

const STAND: Pose = sym({ shoulder: [0, 0, 6], elbow: [-8, 0, 0], hip: [0, 0, 3] })
const SQUAT_LEGS: Limbs = { hip: [-108, 0, 10], knee: [128, 0, 0] } // below parallel, knees travel forward
const PULL_HANG: Pose = { neck: [-10, 0, 0], ...sym({ shoulder: [0, 0, 160], elbow: [0, 0, 6], hip: [-12, 0, 3], knee: [28, 0, 0] }) }
const BAR = 2.3
const HANGING = { hang: BAR, anchor: ['handL', 'handR'], pin: ['hands'], poles: { hands: [1, -0.4, 0.5] } } as const
const ROW_TORSO: Pose = { root: [55, 0, 0], neck: [-35, 0, 0] }
// Floor work pivots over the toes (anchor) while the hands stay pinned where they were placed.
const PRONE = { level: ['handL', 'toeL'], ground: ['handL', 'handR', 'toeL', 'toeR'], anchor: ['toeL', 'toeR'], view: 'side', pin: ['hands'], poles: { hands: [0.6, 0.2, -1] } } as const
const STRAIGHT_LEGS: Limbs = { hip: [0, 0, 2], knee: [0, 0, 0], ankle: [0, 0, 0] }
const SUPINE_KNEES_UP = { level: ['back', 'heelL'], ground: ['back', 'seat', 'heelL', 'heelR'], anchor: ['heelL', 'heelR'], view: 'side' } as const

export const ANIMS: Record<string, Anim> = {
  squat: {
    a: STAND,
    b: { spine: [38, 0, 0], neck: [-25, 0, 0], ...sym({ shoulder: [-128, 0, 6], elbow: [-5, 0, 0], ...SQUAT_LEGS }) },
  },
  // Sit back to a box: shins stay vertical (hip −92 + knee 92 ⇒ shin straight down), thighs parallel, torso leans to balance.
  box_squat: {
    a: STAND,
    b: { spine: [44, 0, 0], neck: [-28, 0, 0], ...sym({ shoulder: [-132, 0, 6], elbow: [-5, 0, 0], hip: [-92, 0, 8], knee: [92, 0, 0] }) },
    period: 3.4,
  },
  squat_goblet: {
    a: { ...STAND, ...sym({ shoulder: [-25, 0, 12], elbow: [-125, 0, 0] }) },
    b: { spine: [28, 0, 0], neck: [-20, 0, 0], ...sym({ shoulder: [-25, 0, 12], elbow: [-125, 0, 0], ...SQUAT_LEGS }) },
  },
  squat_back: {
    a: { ...STAND, ...sym({ shoulder: [30, 0, 60], elbow: [0, 0, 120] }) },
    b: { spine: [30, 0, 0], neck: [-25, 0, 0], ...sym({ shoulder: [30, 0, 60], elbow: [0, 0, 120], ...SQUAT_LEGS }) },
  },
  lunge: {
    a: STAND,
    b: {
      spine: [8, 0, 0], ...sym({ shoulder: [0, 0, 6], elbow: [-8, 0, 0] }),
      hipL: [-88, 0, 3], kneeL: [92, 0, 0], hipR: [22, 0, -3], kneeR: [95, 0, 0], ankleR: [-40, 0, 0],
    },
    ground: ['heelL', 'toeL', 'toeR', 'kneeR'],
    anchor: ['heelL'],
  },
  hinge: {
    a: { ...STAND, ...sym({ shoulder: [0, 0, 4], elbow: [-5, 0, 0] }) },
    b: { root: [70, 0, 0], spine: [5, 0, 0], neck: [-35, 0, 0], ...sym({ shoulder: [-75, 0, 4], elbow: [-5, 0, 0], hip: [-75, 0, 3], knee: [20, 0, 0] }) },
  },
  deadlift: {
    a: { ...STAND, ...sym({ shoulder: [0, 0, 6], elbow: [-3, 0, 0] }) },
    b: { root: [55, 0, 0], spine: [8, 0, 0], neck: [-35, 0, 0], ...sym({ shoulder: [-63, 0, 6], elbow: [-3, 0, 0], hip: [-100, 0, 5], knee: [65, 0, 0] }) },
  },
  swing: {
    a: { root: [60, 0, 0], neck: [-30, 0, 0], ...sym({ shoulder: [-40, 0, 4], hip: [-75, 0, 5], knee: [25, 0, 0] }) },
    b: { ...STAND, ...sym({ shoulder: [-90, 0, 4], elbow: [0, 0, 0] }) },
    period: 1.6,
  },
  bridge: {
    a: { root: [-90, 0, 0], ...sym({ shoulder: [0, 0, 12], elbow: [0, 0, 0], hip: [-60, 0, 5], knee: [110, 0, 0] }) },
    b: { root: [-90, 0, 0], ...sym({ shoulder: [0, 0, 12], elbow: [0, 0, 0], hip: [0, 0, 5], knee: [72, 0, 0] }) },
    ...SUPINE_KNEES_UP,
  },
  pushup: {
    a: { root: [90, 0, 0], neck: [-15, 0, 0], ...sym({ shoulder: [-90, 0, 8], elbow: [0, 0, 0], ...STRAIGHT_LEGS }) },
    b: { root: [90, 0, 0], neck: [-15, 0, 0], ...sym({ shoulder: [15, 0, 22], elbow: [-105, 0, 0], ...STRAIGHT_LEGS }) },
    ...PRONE,
  },
  kneepushup: {
    a: { root: [90, 0, 0], neck: [-15, 0, 0], ...sym({ shoulder: [-90, 0, 8], elbow: [0, 0, 0], hip: [0, 0, 2], knee: [90, 0, 0], ankle: [0, 0, 0] }) },
    b: { root: [90, 0, 0], neck: [-15, 0, 0], ...sym({ shoulder: [15, 0, 22], elbow: [-105, 0, 0], hip: [0, 0, 2], knee: [90, 0, 0], ankle: [0, 0, 0] }) },
    ...PRONE,
    level: ['handL', 'kneeL'],
    ground: ['handL', 'handR', 'kneeL', 'kneeR'],
    anchor: ['kneeL', 'kneeR'],
  },
  plank: {
    a: { root: [90, 0, 0], neck: [-10, 0, 0], ...sym({ shoulder: [-90, 0, 8], elbow: [-90, 0, 0], ...STRAIGHT_LEGS }) },
    b: { root: [90, 0, 0], neck: [-10, 0, 0], spine: [-4, 0, 0], ...sym({ shoulder: [-90, 0, 8], elbow: [-90, 0, 0], ...STRAIGHT_LEGS }) },
    ...PRONE,
    level: ['elbowL', 'toeL'],
    ground: ['elbowL', 'elbowR', 'toeL', 'toeR'],
    anchor: ['elbowL', 'elbowR'],
    pin: [],
    period: 5,
  },
  deadbug: {
    a: { root: [-90, 0, 0], ...sym({ shoulder: [-90, 0, 8], hip: [-90, 0, 4], knee: [90, 0, 0], ankle: [0, 0, 0] }) },
    b: {
      root: [-90, 0, 0], shoulderL: [-170, 0, 8], shoulderR: [-90, 0, -8],
      hipL: [-90, 0, 4], kneeL: [90, 0, 0], hipR: [-10, 0, -4], kneeR: [5, 0, 0], ankleL: [0, 0, 0], ankleR: [0, 0, 0],
    },
    ground: ['back', 'seat'],
    anchor: ['back'],
    view: 'side',
    period: 3.5,
  },
  press_overhead: {
    a: { ...STAND, ...sym({ shoulder: [0, 0, 80], elbow: [0, 0, 95] }) },
    b: { ...STAND, ...sym({ shoulder: [0, 0, 168], elbow: [0, 0, 8] }) },
  },
  curl: {
    a: { ...STAND, ...sym({ shoulder: [0, 0, 5], elbow: [-10, 0, 0] }) },
    b: { ...STAND, ...sym({ shoulder: [-12, 0, 5], elbow: [-140, 0, 0] }) },
    period: 2.6,
  },
  triceps_ext: {
    a: { ...STAND, ...sym({ shoulder: [-188, 0, 12], elbow: [-135, 0, 0] }) },
    b: { ...STAND, ...sym({ shoulder: [-188, 0, 12], elbow: [-8, 0, 0] }) },
  },
  row: {
    a: { ...ROW_TORSO, ...sym({ shoulder: [-55, 0, 6], elbow: [-3, 0, 0], hip: [-62, 0, 4], knee: [18, 0, 0] }) },
    b: { ...ROW_TORSO, ...sym({ shoulder: [15, 0, 14], elbow: [-70, 0, 0], hip: [-62, 0, 4], knee: [18, 0, 0] }) },
    period: 2.6,
  },
  // Hands are pinned to their grip on the bar (IK), so the body rises between them instead of the hands sliding.
  pullup: {
    a: PULL_HANG,
    b: { neck: [-15, 0, 0], ...sym({ shoulder: [-30, 0, 40], elbow: [0, 0, 128], hip: [-20, 0, 3], knee: [35, 0, 0] }) },
    ...HANGING,
  },
  hang: { a: PULL_HANG, b: { ...PULL_HANG, neck: [-4, 0, 0] }, ...HANGING, period: 5 },
  kneeraise: {
    a: PULL_HANG,
    b: { neck: [-10, 0, 0], ...sym({ shoulder: [0, 0, 160], elbow: [0, 0, 6], hip: [-100, 0, 4], knee: [105, 0, 0] }) },
    ...HANGING,
  },
  // Seated cable pulldown: the handle (and its cable) travels with the hands; the body stays on the seat.
  pulldown: {
    a: { root: [-8, 0, 0], ...sym({ shoulder: [0, 0, 162], elbow: [0, 0, 6], hip: [-88, 0, 8], knee: [90, 0, 0] }) },
    b: { root: [-14, 0, 0], neck: [-8, 0, 0], ...sym({ shoulder: [-12, 0, 42], elbow: [0, 0, 128], hip: [-88, 0, 8], knee: [90, 0, 0] }) },
    period: 2.8,
  },
  bench: {
    a: { root: [-90, 0, 0], ...sym({ shoulder: [-90, 0, 10], elbow: [0, 0, 0], hip: [22, 0, 10], knee: [72, 0, 0] }) },
    b: { root: [-90, 0, 0], ...sym({ shoulder: [-8, 0, 76], elbow: [-95, 0, 0], hip: [22, 0, 10], knee: [72, 0, 0] }) },
    ground: ['heelL', 'heelR'],
    view: 'side',
  },
  floorpress: {
    a: { root: [-90, 0, 0], ...sym({ shoulder: [-90, 0, 10], elbow: [0, 0, 0], hip: [-60, 0, 6], knee: [110, 0, 0] }) },
    b: { root: [-90, 0, 0], ...sym({ shoulder: [-2, 0, 78], elbow: [-90, 0, 0], hip: [-60, 0, 6], knee: [110, 0, 0] }) },
    ...SUPINE_KNEES_UP,
  },
  dip: {
    a: { root: [8, 0, 0], neck: [-8, 0, 0], ...sym({ shoulder: [-8, 0, 6], elbow: [0, 0, 0], hip: [-15, 0, 3], knee: [80, 0, 0] }) },
    b: { root: [18, 0, 0], neck: [-15, 0, 0], ...sym({ shoulder: [50, 0, 8], elbow: [-80, 0, 0], hip: [-25, 0, 3], knee: [85, 0, 0] }) },
    hang: 1.25,
    anchor: ['handL', 'handR'],
    pin: ['hands'],
    poles: { hands: [0.3, 0, -1] }, // elbows track straight back
  },
  // Hands on a ledge behind, heels on the floor in front — both pinned, so only the hips travel down.
  benchdip: {
    a: sym({ shoulder: [35, 0, 12], elbow: [0, 0, 0], hip: [-78, 0, 6], knee: [45, 0, 0] }),
    b: { neck: [-6, 0, 0], ...sym({ shoulder: [72, 0, 12], elbow: [-85, 0, 0], hip: [-84, 0, 6], knee: [55, 0, 0] }) },
    hang: 0.5,
    anchor: ['handL', 'handR'],
    pin: ['hands', 'feet'],
    poles: { hands: [0.2, 0, -1], feet: [0, 1, 0.6] },
    view: 'side',
  },
  // Inverted V: hips high, head travels down between the hands.
  pike: {
    a: { root: [130, 0, 0], neck: [10, 0, 0], ...sym({ shoulder: [-140, 0, 10], elbow: [0, 0, 0], hip: [-100, 0, 3], knee: [0, 0, 0], ankle: [0, 0, 0] }) },
    b: { root: [140, 0, 0], neck: [15, 0, 0], ...sym({ shoulder: [-112, 0, 26], elbow: [-85, 0, 0], hip: [-108, 0, 3], knee: [0, 0, 0], ankle: [0, 0, 0] }) },
    ...PRONE,
  },
  // Push-up with hands on a bench: hands sit 0.45 m above the toes.
  incline: {
    a: { root: [70, 0, 0], neck: [-15, 0, 0], ...sym({ shoulder: [-70, 0, 8], elbow: [0, 0, 0], ...STRAIGHT_LEGS }) },
    b: { root: [75, 0, 0], neck: [-15, 0, 0], ...sym({ shoulder: [25, 0, 22], elbow: [-105, 0, 0], ...STRAIGHT_LEGS }) },
    ...PRONE,
    level: ['handL', 'toeL', 0.45],
    ground: ['toeL', 'toeR'],
  },
}
