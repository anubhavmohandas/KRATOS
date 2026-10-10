import * as THREE from 'three'

// Procedural mannequin: a joint hierarchy of capsules, posed by two keyframes per exercise.
// occam: no rigged glTF — swap buildRig() for a GLTFLoader skeleton if you ever want a realistic body.

export type Joint = 'spine' | 'neck' | 'shoulderL' | 'shoulderR' | 'elbowL' | 'elbowR' | 'hipL' | 'hipR' | 'kneeL' | 'kneeR' | 'ankleL' | 'ankleR'
export type Marker = 'handL' | 'handR' | 'elbowL' | 'elbowR' | 'kneeL' | 'kneeR' | 'heelL' | 'heelR' | 'toeL' | 'toeR' | 'back' | 'seat'
export type V3 = [number, number, number]
export type Pose = Partial<Record<Joint | 'root', V3>>
export type Anim = {
  a: Pose
  b: Pose
  ground?: readonly Marker[] // lowest of these touches the floor (default: feet)
  anchor?: readonly Marker[] // average x/z of these stays at the origin (default: heels)
  hang?: number // instead of ground: anchors held at this height (bars)
  level?: readonly [Marker, Marker] | readonly [Marker, Marker, number] // tilt until these two share a height (or differ by the 3rd value)
  pin?: readonly ('hands' | 'feet')[] // keep these exactly where they were at t=0 (on the bar, bench, floor) via IK
  poles?: { hands?: Readonly<V3>; feet?: Readonly<V3> } // which way elbows / knees point while pinned (left side; right is mirrored)
  view?: 'side'
  period?: number // seconds per rep
}
export type Rig = { root: THREE.Group; joints: Record<Joint, THREE.Object3D>; markers: Record<Marker, THREE.Object3D>; pins: Map<Anim, THREE.Vector3[]> }

const JOINTS: Joint[] = ['spine', 'neck', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR']
const FEET: Marker[] = ['heelL', 'heelR', 'toeL', 'toeR']
const SKIN = new THREE.MeshStandardMaterial({ color: 0xc9cec8, roughness: 0.6, metalness: 0.05 })
const JOINT = new THREE.MeshStandardMaterial({ color: 0xc6f432, roughness: 0.45, metalness: 0.2 })
const IRON = new THREE.MeshStandardMaterial({ color: 0x3a3f3b, roughness: 0.35, metalness: 0.8 })
const PLATE = new THREE.MeshStandardMaterial({ color: 0x181b19, roughness: 0.7, metalness: 0.4 })

function group(parent: THREE.Object3D, x = 0, y = 0, z = 0) {
  const g = new THREE.Group()
  g.position.set(x, y, z)
  parent.add(g)
  return g
}

function mesh(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, y = 0, scale: V3 = [1, 1, 1]) {
  const m = new THREE.Mesh(geo, mat)
  m.position.y = y
  m.scale.set(...scale)
  m.castShadow = true
  parent.add(m)
  return m
}

const capsule = (r: number, len: number) => new THREE.CapsuleGeometry(r, len, 6, 16)
const sphere = (r: number) => new THREE.SphereGeometry(r, 18, 14)

export function buildRig(): Rig {
  const root = new THREE.Group()
  mesh(root, capsule(0.115, 0.14), SKIN, 0, [1, 1, 0.8]).rotation.z = Math.PI / 2 // pelvis
  const spine = group(root, 0, 0.06, 0)
  mesh(spine, capsule(0.14, 0.26), SKIN, 0.26, [1.15, 1, 0.75]) // torso
  const neck = group(spine, 0, 0.52, 0)
  mesh(neck, capsule(0.045, 0.06), SKIN, 0.05)
  mesh(neck, sphere(0.105), SKIN, 0.18, [0.92, 1.05, 1]) // head
  const joints: Partial<Rig['joints']> = { spine, neck }
  const markers: Partial<Rig['markers']> = { back: group(spine, 0, 0.32, -0.105), seat: group(root, 0, -0.04, -0.1) }

  for (const s of ['L', 'R'] as const) {
    const x = s === 'L' ? 1 : -1
    const shoulder = group(spine, 0.2 * x, 0.45, 0)
    mesh(shoulder, sphere(0.056), JOINT)
    mesh(shoulder, capsule(0.048, 0.2), SKIN, -0.145)
    const elbow = group(shoulder, 0, -0.29, 0)
    mesh(elbow, sphere(0.046), JOINT)
    mesh(elbow, capsule(0.042, 0.18), SKIN, -0.13)
    const hand = group(elbow, 0, -0.27, 0)
    mesh(hand, sphere(0.05), SKIN)
    const hip = group(root, 0.1 * x, -0.06, 0)
    mesh(hip, sphere(0.07), JOINT)
    mesh(hip, capsule(0.068, 0.3), SKIN, -0.22)
    const knee = group(hip, 0, -0.44, 0)
    mesh(knee, sphere(0.058), JOINT)
    mesh(knee, capsule(0.052, 0.3), SKIN, -0.21)
    const ankle = group(knee, 0, -0.42, 0)
    mesh(ankle, new THREE.BoxGeometry(0.085, 0.06, 0.24), SKIN, -0.04).position.z = 0.06
    Object.assign(joints, { [`shoulder${s}`]: shoulder, [`elbow${s}`]: elbow, [`hip${s}`]: hip, [`knee${s}`]: knee, [`ankle${s}`]: ankle })
    Object.assign(markers, { [`hand${s}`]: hand, [`elbow${s}`]: elbow, [`knee${s}`]: knee, [`heel${s}`]: group(ankle, 0, -0.07, -0.05), [`toe${s}`]: group(ankle, 0, -0.07, 0.18) })
  }
  return { root, joints: joints as Rig['joints'], markers: markers as Rig['markers'], pins: new Map() } // every key filled by the loop above
}

const D = Math.PI / 180
const ZERO: V3 = [0, 0, 0]
const pos = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3())

/** Keyframe pose at t, then plant on the floor / bar. No IK. */
function place({ root, joints, markers }: Rig, anim: Anim, t: number) {
  const at = (k: Joint | 'root') => {
    const a = anim.a[k] ?? ZERO
    const b = anim.b[k] ?? ZERO
    return a.map((v, i) => (v + (b[i] - v) * t) * D) as V3
  }
  root.position.set(0, 1, 0)
  root.rotation.set(...at('root'))
  for (const j of JOINTS) joints[j].rotation.set(...at(j))

  // Keep feet flat by cancelling the leg chain's pitch — unless the keyframes pose the ankle themselves.
  const flatten = () => {
    for (const s of ['L', 'R'] as const) {
      if (anim.a[`ankle${s}`] || anim.b[`ankle${s}`]) continue
      joints[`ankle${s}`].rotation.x = -(root.rotation.x + joints[`hip${s}`].rotation.x + joints[`knee${s}`].rotation.x)
    }
    root.updateMatrixWorld(true)
  }
  flatten()
  if (anim.level) {
    // Pitch about world x by δ so the two markers end `off` apart: v.y·cosδ − v.z·sinδ = off ⇒ δ = atan2(v.y, v.z) − asin(off / |v|).
    const v = pos(markers[anim.level[0]]).sub(pos(markers[anim.level[1]]))
    let off = anim.level[2] ?? 0
    if (v.z < 0) { v.negate(); off = -off } // keep the solution the small rotation
    const r = Math.hypot(v.y, v.z)
    if (r > 1e-4) root.rotation.x += Math.atan2(v.y, v.z) - Math.asin(Math.max(-1, Math.min(1, off / r)))
    flatten()
  }

  const anchors = (anim.anchor ?? ['heelL', 'heelR']).map((m) => pos(markers[m]))
  const c = anchors.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(anchors.length)
  const y = anim.hang !== undefined ? anim.hang - c.y : -Math.min(...(anim.ground ?? FEET).map((m) => pos(markers[m]).y))
  root.position.add(new THREE.Vector3(-c.x, y, -c.z))
  root.updateMatrixWorld(true)
}

const DOWN = new THREE.Vector3(0, -1, 0)

/** Point a bone (whose rest direction is −y) along a world-space direction. Twist is irrelevant: limbs are capsules. */
function aim(bone: THREE.Object3D, dir: THREE.Vector3) {
  const parent = bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert()
  bone.quaternion.setFromUnitVectors(DOWN, dir.clone().applyQuaternion(parent).normalize())
  bone.updateMatrixWorld(true)
}

/** Two-bone IK (law of cosines): bend upper→lower so `end` lands on `target`, the middle joint bulging toward `pole`. */
function reach(upper: THREE.Object3D, lower: THREE.Object3D, end: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3) {
  const S = pos(upper)
  const a = pos(lower).distanceTo(S)
  const b = pos(end).distanceTo(pos(lower))
  const toT = target.clone().sub(S)
  const d = Math.min(a + b - 1e-4, Math.max(Math.abs(a - b) + 1e-4, toT.length()))
  const u = toT.normalize()
  const p = pole.clone().sub(u.clone().multiplyScalar(pole.dot(u))).normalize()
  const cos = (a * a + d * d - b * b) / (2 * a * d)
  const mid = S.clone().addScaledVector(u, a * cos).addScaledVector(p, a * Math.sqrt(Math.max(0, 1 - cos * cos)))
  aim(upper, mid.clone().sub(S))
  aim(lower, S.clone().addScaledVector(u, d).sub(pos(lower)))
}

/** Pose the rig at t ∈ [0, 1], plant it, then pin hands/feet to where they were at t = 0 so nothing slides. */
export function applyPose(rig: Rig, anim: Anim, t: number) {
  if (anim.pin && !rig.pins.has(anim)) {
    place(rig, anim, 0)
    const m = rig.markers
    rig.pins.set(anim, [pos(m.handL), pos(m.handR), pos(rig.joints.ankleL), pos(rig.joints.ankleR)])
  }
  place(rig, anim, t)
  if (!anim.pin) return
  const [hL, hR, fL, fR] = rig.pins.get(anim)!
  const { joints: j, markers: m } = rig
  const mirror = (v: Readonly<V3>) => new THREE.Vector3(-v[0], v[1], v[2])
  if (anim.pin.includes('hands')) {
    const pole = anim.poles?.hands ?? [1, 0, -1]
    reach(j.shoulderL, j.elbowL, m.handL, hL, new THREE.Vector3(...pole))
    reach(j.shoulderR, j.elbowR, m.handR, hR, mirror(pole))
  }
  if (anim.pin.includes('feet')) {
    const pole = anim.poles?.feet ?? [0, 0.5, 1]
    reach(j.hipL, j.kneeL, j.ankleL, fL, new THREE.Vector3(...pole))
    reach(j.hipR, j.kneeR, j.ankleR, fR, mirror(pole))
    for (const a of [j.ankleL, j.ankleR]) { // feet flat on the floor, pointing forward
      a.quaternion.copy(a.parent!.getWorldQuaternion(new THREE.Quaternion()).invert())
      a.updateMatrixWorld(true)
    }
  }
}

// ---- props ------------------------------------------------------------------------

function dumbbell() {
  const g = new THREE.Group()
  mesh(g, new THREE.CylinderGeometry(0.016, 0.016, 0.16, 10), IRON).rotation.z = Math.PI / 2
  for (const x of [-0.09, 0.09]) {
    const head = mesh(g, new THREE.CylinderGeometry(0.05, 0.05, 0.06, 16), PLATE)
    head.rotation.z = Math.PI / 2
    head.position.x = x
  }
  return g
}

function barbell() {
  const g = new THREE.Group()
  mesh(g, new THREE.CylinderGeometry(0.014, 0.014, 1.8, 10), IRON).rotation.z = Math.PI / 2
  for (const x of [-0.62, 0.62]) {
    const plate = mesh(g, new THREE.CylinderGeometry(0.17, 0.17, 0.05, 28), PLATE)
    plate.rotation.z = Math.PI / 2
    plate.position.x = x
  }
  return g
}

function kettlebell() {
  const g = new THREE.Group()
  mesh(g, sphere(0.085), PLATE, -0.1)
  mesh(g, new THREE.TorusGeometry(0.05, 0.012, 8, 20, Math.PI), IRON, -0.03)
  return g
}

/** Adds props to the scene; returns a per-frame updater for the ones that follow the hands or body. */
export function buildProps(names: string[], rig: Rig, anim: Anim, scene: THREE.Scene): () => void {
  const updates: (() => void)[] = []
  const { handL, handR, back } = rig.markers
  const betweenHands = (obj: THREE.Object3D) => {
    scene.add(obj)
    updates.push(() => obj.position.copy(pos(handL).add(pos(handR)).multiplyScalar(0.5)))
  }
  for (const name of names) {
    if (name === 'db2') {
      handL.add(dumbbell())
      handR.add(dumbbell())
    } else if (name === 'db1') betweenHands(dumbbell())
    else if (name === 'kb') betweenHands(kettlebell())
    else if (name === 'bar') betweenHands(barbell())
    else if (name === 'pullbar' && anim.hang) {
      const bar = mesh(scene, new THREE.CylinderGeometry(0.018, 0.018, 1.5, 12), IRON, anim.hang)
      bar.rotation.z = Math.PI / 2
      for (const x of [-0.75, 0.75]) mesh(scene, new THREE.CylinderGeometry(0.025, 0.025, anim.hang, 10), IRON, anim.hang / 2).position.x = x
    } else if (name === 'dipbars' && anim.hang) {
      applyPose(rig, anim, 0)
      const gx = Math.abs(pos(handL).x)
      for (const x of [-gx, gx]) {
        const rail = mesh(scene, new THREE.CylinderGeometry(0.02, 0.02, 0.9, 12), IRON, anim.hang)
        rail.rotation.x = Math.PI / 2
        rail.position.x = x
        mesh(scene, new THREE.CylinderGeometry(0.025, 0.025, anim.hang, 10), IRON, anim.hang / 2).position.set(x, anim.hang / 2, -0.4)
      }
    } else if (name === 'box' || name === 'handbench' || name === 'ledge') {
      // Static furniture sized from the pose: a box under the seat at the bottom of the rep,
      // an incline bench under the hands, or a ledge behind them for bench dips.
      applyPose(rig, anim, name === 'box' ? 1 : 0)
      const at = name === 'box' ? pos(rig.markers.seat).add(new THREE.Vector3(0, -0.075, -0.12)) : pos(handL).add(pos(handR)).multiplyScalar(0.5).add(new THREE.Vector3(0, -0.05, name === 'ledge' ? -0.2 : 0.02))
      const [w, depth] = name === 'box' ? [0.45, 0.42] : name === 'ledge' ? [0.9, 0.45] : [0.9, 0.32]
      const box = mesh(scene, new THREE.BoxGeometry(w, at.y, depth), PLATE, at.y / 2)
      box.position.x = at.x
      box.position.z = at.z
      box.receiveShadow = true
    } else if (name === 'handle') {
      const handle = new THREE.Group()
      mesh(handle, new THREE.CylinderGeometry(0.014, 0.014, 1.05, 10), IRON).rotation.z = Math.PI / 2
      const cable = mesh(scene, new THREE.CylinderGeometry(0.006, 0.006, 1, 6), IRON)
      const TOP = 2.7 // pulley height
      betweenHands(handle)
      updates.push(() => {
        const h = handle.position
        cable.scale.y = Math.max(0.01, TOP - h.y)
        cable.position.set(h.x, (TOP + h.y) / 2, h.z)
      })
    } else if (name === 'bench') {
      const bench = mesh(scene, new THREE.BoxGeometry(1, 1, 1), PLATE)
      bench.receiveShadow = true
      updates.push(() => {
        const p = pos(back)
        const h = Math.max(0.05, p.y)
        bench.scale.set(0.3, h, 1.15)
        bench.position.set(p.x, h / 2, p.z + 0.2)
      })
    }
  }
  return () => updates.forEach((u) => u())
}
