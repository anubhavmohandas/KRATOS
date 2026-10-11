import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { defineConfig, devices } from '@playwright/test'

// End-to-end against the real thing: the built UI served by the API, on a throwaway DB, AI off.
// `npm run e2e` builds first. Projects share one server, so they run one after another.
const PORT = +(process.env.KRATOS_E2E_PORT ?? 8765) // another port lets two runs share a machine

// Chrome's fake camera films the app's own 3D mannequin, which MediaPipe reads as a person: 10 s facing the camera,
// then 10 s side-on, looping — enough for a body scan's front and side captures.
const still = (name: string) => gunzipSync(readFileSync(join(import.meta.dirname, 'e2e/fixtures', `mannequin-${name}.yuv.gz`)))
const person = join(tmpdir(), 'kratos-mannequin.y4m')
const frames = [...Array(100).fill(still('front')), ...Array(100).fill(still('side'))]
writeFileSync(person, Buffer.concat([Buffer.from('YUV4MPEG2 W480 H270 F10:1 Ip A1:1 C420jpeg\n'), ...frames.flatMap((f) => [Buffer.from('FRAME\n'), f])]))
const camera = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${person}`,
  '--autoplay-policy=no-user-gesture-required']

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'], launchOptions: { args: camera } } },
    { name: 'android-chrome', use: { ...devices['Pixel 7'], launchOptions: { args: camera } } },
    { name: 'iphone-safari', use: { ...devices['iPhone 15'] } },
  ],
  webServer: {
    command: `d=$(mktemp -d) && cd ../api && KRATOS_DB=$d/kratos.db KRATOS_PASSWORD=e2e-password-1234 KRATOS_LLM_API_KEY= NVIDIA_API_KEY= exec .venv/bin/uvicorn main:app --host 127.0.0.1 --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
  },
})
