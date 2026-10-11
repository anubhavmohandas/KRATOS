import { expect, fresh, login, noSideScroll, pdf, seed, test, wav } from './helpers'

test('every page and API route is behind the password', async ({ page }) => {
  await page.goto('/train/library')
  await expect(page).toHaveURL(/\/login$/)
  expect((await page.request.get('/api/profile')).status()).toBe(401)
  await page.getByLabel('Password').fill('not the password')
  await page.getByRole('button', { name: 'Log in' }).click()
  await expect(page.getByRole('alert')).toHaveText('Wrong password.')
  await login(page)
  await expect(page).not.toHaveURL(/\/login$/)
})

test('first run: profile and gear → plan → workout with 3D demo → progress', async ({ page }) => {
  await fresh(page)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Tell me about you' })).toBeVisible()
  await noSideScroll(page)
  await page.getByRole('button', { name: 'Add Dumbbells' }).click()
  await expect(page.getByText('2–20 kg · 10 weights')).toBeVisible()
  await page.getByRole('button', { name: 'Save & continue' }).click()
  await expect(page).toHaveURL(/\/train$/)

  await page.getByRole('button', { name: 'Generate my plan' }).click()
  const start = page.getByRole('button', { name: /^Start / })
  await expect(start).toBeVisible()
  await start.click()
  await expect(page.getByText(/^Live · /)).toBeVisible()

  // The 3D trainer draws and animates: two frames a moment apart differ.
  const demo = page.getByRole('img', { name: /^3D demonstration/ })
  await expect(demo.locator('canvas')).toBeVisible()
  await page.waitForTimeout(800)
  const a = await demo.screenshot()
  await page.waitForTimeout(700)
  const b = await demo.screenshot()
  expect(a.length, 'the 3D view is not a blank frame').toBeGreaterThan(8000)
  expect(a.equals(b), 'the 3D demo animates').toBe(false)

  const reps = page.getByLabel(/^(Reps|Seconds)$/)
  await reps.fill('8')
  await page.getByRole('button', { name: 'Log set' }).click()
  await expect(page.getByText(/^#1 · /)).toBeVisible()
  await expect(page.getByRole('timer')).toContainText('Rest')
  await page.getByRole('button', { name: 'Delete set 1' }).click()
  await expect(page.getByText(/^#1 · /)).toHaveCount(0)
  await reps.fill('9')
  await page.getByRole('button', { name: 'Log set' }).click()
  await expect(page.getByText(/^#1 · .*× 9/)).toBeVisible()

  await page.reload() // a reload mid-workout resumes it, sets included
  await expect(page.getByText(/^#1 · .*× 9/)).toBeVisible()
  await expect(page.getByLabel(/^(Reps|Seconds)$/)).toHaveValue('9') // prefilled from the logged set

  await page.getByRole('button', { name: 'Finish workout' }).click()
  await expect(page.getByRole('heading', { name: /— done$/ })).toBeVisible()
  await page.getByRole('button', { name: 'Back to plan' }).click()
  await expect(page.getByRole('button', { name: /^Start / })).toBeVisible()

  await page.goto('/progress')
  await expect(page.getByText('Workouts', { exact: true }).locator('..')).toContainText('1')
})

test('a workout resumes on another device; a vanished one never traps you', async ({ page, browser }, info) => {
  await fresh(page)
  await seed(page)
  const plan = await (await page.request.get('/api/plans/active')).json()
  const s = await (await page.request.post('/api/sessions', { data: { plan_id: plan.id, day_index: 0 } })).json()

  const other = await browser.newContext(info.project.use) // a second phone or laptop: no shared storage
  const phone = await other.newPage()
  await login(phone)
  await phone.goto('/train')
  await expect(phone.getByText(/^Live · /)).toBeVisible()
  await other.close()

  await page.request.post(`/api/sessions/${s.id}/complete`)
  await page.goto('/')
  await page.evaluate((id) => localStorage.setItem('kratos.session', JSON.stringify({ id: 99999, plan_id: id, day: 0 })), plan.id)
  await page.goto('/train')
  await expect(page.getByRole('button', { name: /^Start / })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('kratos.session'))).toBeNull()
})

test('timers survive a reload; the coach says plainly when AI is off', async ({ page }) => {
  await fresh(page)
  await seed(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Rest 90s' }).click()
  await expect(page.getByRole('timer')).toContainText('1:2')
  await page.reload()
  await expect(page.getByRole('link', { name: /1:[0-2]\d Rest/ })).toBeVisible()

  await page.getByRole('button', { name: 'Ask KRATOS' }).click()
  await expect(page.getByRole('dialog', { name: 'Ask KRATOS' })).toContainText('AI not configured')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('music: your files play, persist, and deleting the playing one stops it', async ({ page }) => {
  await fresh(page)
  await seed(page)
  await page.goto('/space/music')
  await page.locator('input[type=file][accept="audio/*"]').setInputFiles([
    { name: 'tone-a.wav', mimeType: 'audio/wav', buffer: wav(4) },
    { name: 'tone-b.wav', mimeType: 'audio/wav', buffer: wav(4, 660) },
  ])
  await expect(page.getByRole('button', { name: 'Play tone-a' })).toBeVisible()
  await page.reload() // stored in this browser's IndexedDB
  await page.getByRole('button', { name: 'Play tone-a' }).click()
  await expect(page.getByRole('button', { name: 'Pause' }).first()).toBeVisible()
  await expect(page.getByText(/^0:0[1-3]$/).first()).toBeVisible() // time moves (the length shows as 0:04)
  page.once('dialog', (d) => d.accept())
  await page.getByRole('listitem').filter({ hasText: 'tone-a' }).getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByRole('link', { name: 'Open player' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Play tone-b' })).toBeVisible()
})

test('camera: a full body scan measures the person in frame; the rep counter starts and stops', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright WebKit has no fake camera; check on a real iPhone')
  test.setTimeout(150_000)
  await fresh(page)
  await seed(page)
  await page.goto('/body')
  await page.getByRole('button', { name: 'Start scan' }).click()
  await expect(page.getByText('Camera on · processed on this device')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Step 1 · Face the camera')).toBeVisible()
  // Pose found → position cues → auto countdown → front capture → side capture → results.
  await expect(page.getByRole('button', { name: 'Save results' })).toBeVisible({ timeout: 90_000 })
  const confidence = await page.getByText('Landmark confidence').locator('xpath=following-sibling::dd').textContent()
  expect(parseInt(confidence!), 'MediaPipe saw a body').toBeGreaterThanOrEqual(75)
  await expect(page.getByText(/Shoulder joint width \(est\.\)/)).toBeVisible()
  await page.getByRole('button', { name: 'Save results' }).click()
  await expect(page.getByRole('cell', { name: 'camera' })).toBeVisible()

  await page.getByRole('button', { name: 'Start scan' }).click()
  await expect(page.getByText('Camera on · processed on this device')).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Stop camera' }).click()
  await expect(page.getByRole('button', { name: 'Start scan' })).toBeVisible()

  await page.goto('/train')
  await page.getByRole('button', { name: /^Start / }).click()
  const tabs = page.getByRole('navigation', { name: 'Exercises' }).getByRole('button')
  for (let i = 0; i < await tabs.count(); i++) {
    await tabs.nth(i).click()
    if (await page.getByRole('button', { name: 'Count reps with camera' }).isVisible()) break
  }
  await page.getByRole('button', { name: 'Count reps with camera' }).click()
  await expect(page.getByText('Camera on · processed on this device')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/counts \d+° → \d+° → \d+°/)).toBeVisible()
  await page.getByRole('button', { name: 'Stop camera' }).click()
  await expect(page.getByRole('button', { name: 'Count reps with camera' })).toBeVisible()
})

test('PDF import: text plan → review → new plan version', async ({ page }) => {
  await fresh(page)
  await seed(page)
  await page.goto('/space/pdf')
  await page.getByLabel(/Workout PDF/).setInputFiles({ name: 'coach.pdf', mimeType: 'application/pdf', buffer: pdf(['Day 1 - Push', 'Push-ups 3 x 10', 'Goblet squat 3x12 rest 90s', 'Forearm plank 3 x 45 sec']) })
  await page.getByRole('button', { name: 'Extract' }).click()
  await expect(page.getByLabel('Day name')).toHaveValue('Day 1 - Push')
  await expect(page.getByLabel('Exercise for “Push-ups”')).toHaveValue('pushup')
  await page.getByRole('button', { name: 'Create plan from import' }).click()
  await expect(page).toHaveURL(/\/train$/)
  await expect(page.getByText(/Plan v2 .* import/)).toBeVisible()
})

test('backups: download one, wipe everything, undo the wipe from Settings', async ({ page }) => {
  await fresh(page)
  await seed(page)
  await page.goto('/space/settings')
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download backup' }).click()
  expect((await download).suggestedFilename()).toMatch(/^kratos-\d{4}-\d{2}-\d{2}\.db$/)

  page.on('dialog', (d) => d.accept())
  await page.getByRole('button', { name: 'Delete everything' }).click()
  await expect(page.getByRole('heading', { name: 'Tell me about you' })).toBeVisible()
  await page.getByRole('link', { name: 'Restore a backup' }).click()
  await page.getByRole('button', { name: 'Restore', exact: true }).first().click() // newest: taken just before the wipe
  await expect(page.getByText(/Good (morning|afternoon|evening)|Late session/)).toBeVisible()
})

test('every page fits a phone screen', async ({ page }) => {
  await fresh(page)
  await seed(page)
  for (const path of ['/', '/train', '/train/library', '/train/versions', '/coach', '/body', '/progress', '/space/music', '/space/timers', '/space/pdf', '/space/settings']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    await noSideScroll(page)
  }
})

test('log out everywhere ends every session', async ({ page, browser }, info) => {
  await login(page)
  const other = await browser.newContext(info.project.use)
  const laptop = await other.newPage()
  await login(laptop)
  await page.goto('/space/settings')
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: 'Log out everywhere' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await laptop.goto('/progress')
  await expect(laptop).toHaveURL(/\/login$/)
  await other.close()
})
