import { test as base, expect, type Page } from '@playwright/test'

export const PASSWORD = 'e2e-password-1234'

/** Every test fails on an uncaught page error or a Content-Security-Policy violation. */
export const test = base.extend<{ problems: string[] }>({
  problems: [async ({ page }, use) => {
    const problems: string[] = []
    // --mute-audio doesn't reach macOS's system speech, so the body-scan voice cues would talk out loud during a run.
    await page.addInitScript(() => { if (globalThis.speechSynthesis) speechSynthesis.speak = () => {} })
    // WebKit words a same-origin fetch cancelled by navigating away as an "access control" failure; nothing failed.
    page.on('pageerror', (e) => { if (!/due to access control checks\.$/.test(e.message)) problems.push(`page error: ${e.message}`) })
    // MediaPipe's usage telemetry is meant to be blocked (see CSP in api/main.py).
    page.on('console', (m) => { if (/Refused to|Content Security Policy/i.test(m.text()) && !m.text().includes('odml.pa.googleapis.com')) problems.push(`CSP: ${m.text()}`) })
    await use(problems)
    expect(problems, 'browser errors or CSP violations').toEqual([])
  }, { auto: true }],
})
export { expect }

export async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Log in' }).click()
  await page.waitForURL((u) => u.pathname !== '/login')
}

/** Logged in, with an empty database and a fresh browser. */
export async function fresh(page: Page) {
  await login(page)
  expect((await page.request.delete('/api/data')).status()).toBe(204)
  await page.evaluate(() => localStorage.clear())
}

/** Profile, dumbbells 2–20 kg and a generated plan, through the API. */
export async function seed(page: Page) {
  const ok = async (r: Promise<{ ok(): boolean; status(): number }>) => expect((await r).ok()).toBe(true)
  await ok(page.request.put('/api/profile', { data: { age: 30, height_cm: 178, weight_kg: 80, experience: 'beginner', goal: 'strength', days_per_week: 3, session_minutes: 45 } }))
  await ok(page.request.post('/api/equipment', { data: { type: 'dumbbells', weights_kg: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20] } }))
  await ok(page.request.post('/api/equipment', { data: { type: 'bench', weights_kg: [] } }))
  await ok(page.request.post('/api/plans/generate'))
}

/** A short mono 16-bit WAV tone, so music tests need no binary fixture. */
export function wav(seconds: number, freq = 440): Buffer {
  const rate = 8000
  const n = seconds * rate
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), 44 + i * 2)
  return b
}

/** A one-page text PDF (Helvetica), so import tests need no binary fixture. */
export function pdf(lines: string[]): Buffer {
  const text = lines.map((l, i) => `BT /F1 12 Tf 50 ${750 - i * 18} Td (${l.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n')
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const at = objs.map((o, i) => { const pos = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return pos })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** The page never scrolls sideways (phone layouts). */
export async function noSideScroll(page: Page) {
  const [sw, w] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth])
  expect(sw, `page is ${sw}px wide in a ${w}px viewport`).toBeLessThanOrEqual(w)
}
