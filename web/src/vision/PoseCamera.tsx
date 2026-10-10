import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DrawingUtils, FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import type { Lm } from './metrics'

// WASM is copied into public/ on `npm install`, so its version always matches the JS package.
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task'
let landmarker: Promise<PoseLandmarker> | null = null

function getLandmarker() {
  landmarker ??= FilesetResolver.forVisionTasks('/mediapipe')
    .then((files) => PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' }, runningMode: 'VIDEO', numPoses: 1 }))
    .catch((e) => {
      landmarker = null
      throw e
    })
  return landmarker
}

export type Frame = { lm: Lm[]; width: number; height: number }

/** Live camera with skeleton overlay. Frames are processed on this device and never uploaded. */
export default function PoseCamera({ onFrame, onStop, children }: { onFrame: (f: Frame) => void; onStop: () => void; children?: ReactNode }) {
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const cb = useRef(onFrame)
  cb.current = onFrame
  const [status, setStatus] = useState<'starting' | 'live' | 'error'>('starting')
  const [error, setError] = useState('')

  useEffect(() => {
    let stream: MediaStream | null = null
    let raf = 0
    let stopped = false
    ;(async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera API (needs HTTPS or localhost).')
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
        if (stopped) return stream.getTracks().forEach((t) => t.stop())
        const v = video.current!
        v.srcObject = stream
        await v.play()
        const pose = await getLandmarker()
        if (stopped) return
        setStatus('live')
        const ctx = canvas.current!.getContext('2d')!
        const draw = new DrawingUtils(ctx)
        let lastTime = -1
        const loop = () => {
          if (stopped) return
          if (v.readyState >= 2 && v.currentTime !== lastTime) {
            lastTime = v.currentTime
            const res = pose.detectForVideo(v, performance.now())
            const c = canvas.current!
            if (c.width !== v.videoWidth) Object.assign(c, { width: v.videoWidth, height: v.videoHeight })
            ctx.clearRect(0, 0, c.width, c.height)
            const lm = res.landmarks[0] ?? []
            if (lm.length) {
              draw.drawConnectors(lm, PoseLandmarker.POSE_CONNECTIONS, { color: '#c6f432', lineWidth: 4 })
              draw.drawLandmarks(lm, { color: '#eef2ec', fillColor: '#0a0b0a', radius: 3, lineWidth: 2 })
            }
            cb.current({ lm, width: v.videoWidth, height: v.videoHeight })
          }
          raf = requestAnimationFrame(loop)
        }
        loop()
      } catch (e) {
        if (stopped) return
        const name = (e as DOMException)?.name
        setError(
          name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in the browser’s site settings and try again.'
            : name === 'NotFoundError' ? 'No camera found.'
              : name === 'NotReadableError' ? 'The camera is in use by another app.'
                : (e as Error).message || 'Couldn’t start the camera or load the pose model.',
        )
        setStatus('error')
      }
    })()
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return (
    <div className="relative overflow-hidden rounded-xl border border-iron-700 bg-black">
      {/* Mirrored like a mirror; landmarks stay in raw-image coordinates. */}
      <video ref={video} playsInline muted className="block aspect-video w-full -scale-x-100 object-cover" />
      <canvas ref={canvas} className="absolute inset-0 h-full w-full -scale-x-100 object-cover" aria-hidden />
      <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-xs font-semibold text-bone">
        <span className={`size-2 rounded-full ${status === 'live' ? 'animate-pulse bg-ember' : 'bg-ash'}`} aria-hidden />
        {status === 'live' ? 'Camera on · processed on this device' : status === 'starting' ? 'Starting camera & pose model…' : 'Camera off'}
      </div>
      <button onClick={onStop} className="absolute right-3 top-3 rounded-md bg-black/70 px-3 py-1 text-xs font-semibold text-bone hover:bg-black">
        Stop camera
      </button>
      {status === 'live' && children}
      {status === 'error' && <p role="alert" className="absolute inset-x-0 bottom-0 bg-ember/90 px-4 py-3 text-sm text-iron-950">{error}</p>}
    </div>
  )
}
