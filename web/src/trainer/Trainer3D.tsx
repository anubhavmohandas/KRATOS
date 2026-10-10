import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { ANIMS } from './anims'
import { applyPose, buildProps, buildRig } from './mannequin'

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** 0→1→0 per rep with a short pause at each end. */
function ease(phase: number) {
  const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2
  const s = Math.min(1, Math.max(0, (tri - 0.08) / 0.84))
  return s * s * (3 - 2 * s)
}

export default function Trainer3D({ anim: key, props = [], label }: { anim: string; props?: string[]; label: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(() => !reducedMotion())
  const [speed, setSpeed] = useState(1)
  const [failed, setFailed] = useState(false)
  const ctl = useRef({ playing, speed })
  ctl.current = { playing, speed }
  const propKey = props.join(',')

  useEffect(() => {
    const el = host.current!
    const anim = ANIMS[key] ?? ANIMS.squat
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true })
    } catch {
      setFailed(true)
      return
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x101211)
    scene.fog = new THREE.Fog(0x101211, 7, 14)
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 50)
    const side = anim.view === 'side'
    camera.position.set(side ? 3.8 : 2.6, side ? 1.4 : 1.8, side ? 0.8 : 3.6)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, (anim.hang ?? 0) > 1 ? 1.45 : side ? 0.45 : 0.85, 0) // bars: look up at the body
    Object.assign(controls, { enablePan: false, enableDamping: true, minDistance: 2, maxDistance: 8, maxPolarAngle: Math.PI * 0.49 })

    scene.add(new THREE.HemisphereLight(0xf2f6f0, 0x141614, 0.9))
    const key_ = new THREE.DirectionalLight(0xffffff, 2.2) // one overhead light
    key_.position.set(2, 5, 3)
    key_.castShadow = true
    key_.shadow.mapSize.set(1024, 1024)
    Object.assign(key_.shadow.camera, { left: -2, right: 2, top: 3, bottom: -1 })
    scene.add(key_)
    const rim = new THREE.DirectionalLight(0xd8e6c4, 0.7) // faint lime-white rim — a saturated rim tints the floor
    rim.position.set(-3, 2, -3)
    scene.add(rim)
    const floor = new THREE.Mesh(new THREE.CircleGeometry(4, 64), new THREE.MeshStandardMaterial({ color: 0x161917, roughness: 0.95 }))
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    scene.add(floor, new THREE.PolarGridHelper(2.5, 8, 5, 64, 0x262b27, 0x262b27))

    const rig = buildRig()
    scene.add(rig.root)
    const updateProps = buildProps(props, rig, anim, scene)
    // Frame the body, not the world origin — floor work is planted at the toes, so the hips sit off-centre.
    applyPose(rig, anim, 0)
    const hips = rig.root.getWorldPosition(new THREE.Vector3())
    controls.target.x = hips.x
    controls.target.z = hips.z
    camera.position.x += hips.x
    camera.position.z += hips.z

    const resize = () => {
      renderer.setSize(el.clientWidth, el.clientHeight)
      camera.aspect = el.clientWidth / Math.max(1, el.clientHeight)
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(resize)
    ro.observe(el)

    let phase = 0
    let last = performance.now()
    let raf = 0
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (ctl.current.playing) phase = (phase + (dt * ctl.current.speed) / (anim.period ?? 3)) % 1
      applyPose(rig, anim, ease(phase))
      updateProps()
      controls.update()
      renderer.render(scene, camera)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      scene.traverse((o) => o instanceof THREE.Mesh && o.geometry.dispose())
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [key, propKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative h-full min-h-72 overflow-hidden rounded-xl border border-iron-700 bg-iron-900">
      <div ref={host} className="absolute inset-0 cursor-grab active:cursor-grabbing" role="img" aria-label={`3D demonstration: ${label}`} />
      {failed && <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-ash">3D needs WebGL, which this browser has turned off.</p>}
      <div className="absolute inset-x-3 bottom-3 flex items-center gap-2">
        <button onClick={() => setPlaying((p) => !p)} className="rounded-md bg-iron-950/80 px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-bone backdrop-blur hover:bg-iron-800">
          {playing ? 'Pause' : 'Play'}
        </button>
        <button onClick={() => setSpeed((s) => (s === 1 ? 0.5 : 1))} aria-label={`Playback speed ${speed}×`} className="rounded-md bg-iron-950/80 px-3 py-1.5 font-mono text-xs text-bone backdrop-blur hover:bg-iron-800">
          {speed}×
        </button>
        <span className="ml-auto text-[11px] text-ash">Drag to rotate · scroll to zoom</span>
      </div>
    </div>
  )
}
