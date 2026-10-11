import { defineConfig, devices } from '@playwright/test'

// End-to-end against the real thing: the built UI served by the API, on a throwaway DB, AI off.
// `npm run e2e` builds first. Projects share one server, so they run one after another.
const PORT = 8765
const camera = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
const video = process.env.KRATOS_FAKE_VIDEO // a .y4m of a person; without it the fake camera shows a test pattern
if (video) camera.push(`--use-file-for-fake-video-capture=${video}`)

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
