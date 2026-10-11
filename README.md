# KRATOS

Personal fitness intelligence. Plans are built from the equipment you actually own, and loads are calibrated from the sets you log. You also get:
- a 3D trainer for every exercise
- camera rep counting and body assessment that run on your device
- a music player and timer suite that follow you through the workout
- PDF workout import, scanned PDFs included (OCR)
- a training calendar that exports to your phone's calendar
- a daily recovery check-in with a readiness score
- a nutrition log against a protein target
- a form review of camera-counted sets
- offline workouts: the installed app opens without a connection, and sets logged offline sync when it's back

Single user, behind one password. Workouts and body data live in `api/kratos.db`, with a daily snapshot in `api/backups/`. Music lives in your browser.

## Run

```sh
./start.sh            # first run installs everything → http://localhost:8000
```

For scanned PDFs install Tesseract (`brew install tesseract`); the Docker image already has it. Set `KRATOS_PASSWORD` (12+ characters) in `.env` first, and once per clone run `git config core.hooksPath .githooks` so a commit can never carry `.env` or an API key. The API refuses to start without it. The password guards every page and API route, `/api/docs` included.

Access protection, all in `api/main.py`:
- a signed HttpOnly 30-day cookie; **Settings → Log out everywhere** ends every session (for a lost phone)
- 10 failed logins a minute lock out that address, and 100 a minute lock out everyone
- foreign `Host` headers are refused, and so are cross-site writes
- strict security headers (CSP, no framing, nosniff)
- free-text fields refuse control characters

Development with hot reload (two terminals):

```sh
cd api && .venv/bin/uvicorn main:app --env-file ../.env --reload   # API on :8000
cd web && npm run dev                                               # UI on :5173, proxies /api
```

**Configuration lives in `.env` at the project root** (created from `.env.example` on first run, gitignored). AI is optional. Set `KRATOS_LLM_API_KEY` (or `NVIDIA_API_KEY`) to enable "Why this plan?", Ask KRATOS and AI parsing for messy PDFs. The default provider is NVIDIA NIM; any OpenAI-compatible endpoint works via `KRATOS_LLM_BASE_URL` / `KRATOS_LLM_MODEL`.

## Deploy

The `Dockerfile` builds one image: the API serving the built UI on port 8000. The host needs a persistent volume mounted at `/data` (the DB and its backups) and HTTPS in front. Set these as host secrets, never in the image:

- `KRATOS_PASSWORD`
- `KRATOS_HOSTS=your.domain`
- `KRATOS_LLM_API_KEY`, if you want the AI features

Point the host's health check at `/healthz`. It needs no login and fails if the database on the volume can't be read.

Backups run inside the API: when the newest snapshot is over a day old, it takes a new one and verifies it restores. It also snapshots before **Delete everything** and before every restore. The last 14 are kept on the same disk as the DB.

**Settings → Backups** lists them, each with a Restore button. It also offers **Download backup**, a fresh verified `.db`, and **Restore from a file**. A restore refuses a damaged file, one from another app, and one carrying triggers or views. No restart is needed.

To survive losing the server's disk, pull a copy off it daily. For example, on a Mac save the password with `printf %s 'your-password' > ~/.kratos-pw && chmod 600 ~/.kratos-pw`, `mkdir ~/KRATOS-backups`, and add this with `crontab -e`:

```sh
0 9 * * * curl -sc /tmp/kratos.jar --data-urlencode password@$HOME/.kratos-pw https://your.domain/login >/dev/null && curl -sfb /tmp/kratos.jar -o ~/KRATOS-backups/kratos-$(date +\%F).db https://your.domain/api/backup
```

From a shell on the server, `python backup.py restore /data/backups/<file>` does the same restore; restart the API afterwards.

Camera features need `localhost` or HTTPS, so opening the app from your phone over the LAN needs HTTPS. Install it as an app from the browser's install button (PWA manifest included).

## Pages

| Path | What's there |
|---|---|
| `/` | Dashboard: today's workout, duration, weekly consistency, music, timers, records |
| `/train` · `/train/library` · `/train/calendar` · `/train/versions` | Plan and workout player · all 45 exercises in 3D · month view of done and planned workouts, training days and time, `.ics` export with reminders · plan history (edits and imports never overwrite) |
| `/coach` | Ask KRATOS (LLM), goals, profile, limitations, equipment |
| `/body` · `/body/recovery` · `/body/nutrition` | Hands-free front/side camera scan (auto-captures when you're in position, with voice cues), tape and scale measurements, change since last time, history · daily check-in (sleep, energy, soreness, stress) and readiness trend · food log against protein and calorie targets |
| `/progress` | Estimated 1RM trend, body weight, personal records, weekly consistency |
| `/space/music` · `/space/timers` · `/space/pdf` · `/space/settings` | Player and playlists (your files plus YouTube video/playlist links) · rest, stopwatch, Tabata, intervals, full screen · PDF Studio · export/delete data |

These are real URLs. Deep links and refreshes work because the API serves `index.html` for any non-`/api` path.

## How it decides things

| Job | Who does it | Where |
|---|---|---|
| Exercises, sets, reps, rest | Deterministic engine: equipment + limitations + goal + experience | `api/engine.py` |
| Today's load and reps | Best recent set → estimated 1RM (Epley) → the heaviest weight you own that hits the rep range with ~2 reps in reserve | `engine.prescribe` |
| Explanations, Q&A, messy PDFs | Hosted LLM. Output is schema-validated and re-matched to the catalog; it never picks exercises or loads | `api/ai.py` |
| Rep counting, body proportions | MediaPipe Pose in the browser. Frames never leave the device; only numbers are saved | `web/src/vision/` |
| Exercise demos | Procedural Three.js mannequin, two keyframes per movement, auto-planted on the floor or bar | `web/src/trainer/` |
| Timers | Wall-clock math, so they stay right in background tabs and survive navigation and reloads | `web/src/timer/` |
| Readiness | Weighted from your own answers: sleep 35%, energy 25%, soreness 25%, stress 15%. Below 70 the workout shows the advice (an extra rep in reserve, or go light). A nudge, not a measurement | `engine.readiness` |
| Protein target | Body weight × 1.4–2.0 g/kg by goal. KRATOS doesn't guess calorie needs; you set that target | `web/src/pages/Nutrition.tsx` |
| Form review | Read from the rep counter's own verdicts: reps counted, attempts refused and why, seconds per rep, and whether the tempo slowed | `web/src/vision/review.ts` |
| Scanned PDFs | Each page rendered at 200 dpi (pdfium) and read by Tesseract. All PDF parsing runs in a child process with a time limit, so a hostile file can't stall or crash the API | `api/pdf_import.py` |
| Offline | A service worker caches the app, the plan and the workout. Sets logged offline wait in an outbox and replay in order. The API treats a resent set as the same set, so a replay never doubles one | `web/public/sw.js`, `web/src/api.ts` |
| Music | One app-wide `<audio>` for your files (IndexedDB, lock-screen controls) plus YouTube's official embedded player for links. It streams, never downloads, and stays visible while playing, as YouTube's terms require | `web/src/music/` |

If an exercise has no history yet, KRATOS asks for a calibration set instead of inventing a load.

## Map

```
.env / .env.example   configuration (AI key, model, DB path)
api/
  main.py             routes, SQLite schema, validation at every input, SPA fallback
  engine.py           plan generation, load prescription, readiness
  exercises.json      curated catalog (equipment, contraindications, cues, animation, rep-counter profile)
  pdf_import.py       PDF text (or OCR, in a child process) → sets×reps rows → fuzzy catalog match
  backup.py           daily SQLite snapshots, verified restore
  ai.py               OpenAI-compatible client (NVIDIA NIM default)
web/src/
  main.tsx, router.tsx  shell + History-API routing
  pages/              Dashboard · Train (+ Session, Library, Calendar) · Coach · Body (+ Recovery, Nutrition) · Progress · Space
  calendar.ts         planned dates + .ics
  trainer/ vision/ timer/ music/
web/public/sw.js      offline service worker
web/e2e/              Playwright end-to-end tests
```

To add an exercise, add one entry to `exercises.json`. Reuse an existing `anim`, or add keyframes in `web/src/trainer/anims.ts`.

## Checks

```sh
cd api && .venv/bin/python test_engine.py && .venv/bin/python pdf_import.py && .venv/bin/python ai.py   # OCR check needs `brew install tesseract`
cd api && .venv/bin/python test_api.py && .venv/bin/python backup.py test
cd web && npm test && npx tsc
cd web && npx playwright install chromium webkit && npm run e2e   # first time; afterwards just npm run e2e
```

`test_engine.py` generates about 64k plan items across equipment sets, splits, goals and limitations. It asserts that none needs equipment you don't own, hits an excluded limitation, or triggers a false "no exercise fits" warning. `ai.py` checks that AI-parsed plans drop bad items without rejecting the rest, and that a 429, bad key, outage, dropped connection, timeout or junk reply from the provider each becomes a clear error. `test_api.py` starts a real server and checks that every route is gated, that forged and expired cookies are refused, and that login is throttled. It then runs the core journey with the AI provider down: plan, a resent set (stored once), undo, resume, finish, progress, a corrupt PDF and delete-all. `backup.py test` checks the snapshot, prune and restore cycle. `npm run e2e` builds the UI and runs it against a real API on a throwaway DB. It drives desktop Chrome, Android Chrome (Pixel 7) and iPhone Safari (WebKit, iPhone 15), and fails on any page error or CSP violation. It covers:
- the password gate
- first run through plan, workout and progress, including a 3D demo that is drawn and animating
- a reload mid-workout, resume on a second device, and a stale session that must not trap you
- timers across a reload, and the coach with AI off
- music files that play, persist, and stop when deleted
- the camera scan and rep counter, which start, load the pose model and stop (Chrome's fake camera; WebKit has none)
- PDF import, text and scanned (OCR)
- backup download, wipe and undo, log out everywhere
- a low recovery check-in reaching the workout, meals against the protein target, calendar days and `.ics` export, body change since last time
- offline: the app reopens without a connection, a set logged offline shows as pending and syncs when it's back (Chrome)
- every page at phone width without sideways scroll

`npm test` covers the rep counter, body metrics, scan positioning cues, timer maths, and that every exercise has its own 3D animation.

## Device checks

`npm run e2e` drives the real app in desktop Chrome, a Pixel 7 profile and an iPhone 15 profile (WebKit). For the camera, Chrome's fake webcam plays a clip of KRATOS's own 3D mannequin, 10 s facing the camera and 10 s side-on (`web/e2e/fixtures`). MediaPipe reads it as a person, so the body scan runs for real: position cues, auto countdown, front and side capture, results, save. The 3D demo is checked for drawing and animating, and music for playing and persisting. CSP is enforced throughout. MediaPipe's attempt to send usage telemetry to Google is blocked on purpose.

What only a real phone can confirm, once it's on HTTPS:
- [ ] **iPhone (Safari and the home-screen app):** the camera prompt and front camera; spoken scan cues are audible; a real squat is counted after the live check; touch rotates the 3D demo; music keeps playing with the screen locked and shows lock-screen controls; the YouTube player plays inline.
- [ ] **Android (Chrome, installed app):** the same, plus timer vibration (iOS has no vibration API).

## Honest limits

- **Body metrics are estimates:** joint-centre widths calibrated from your height, ratios and tilt. There's no body-fat %, because a webcam can't measure it reliably.
- **Rep-counter thresholds are fixed per movement** (`vision/metrics.ts` → `PROFILES`). Film from the side, and tune them if your angle reads differently.
- **OCR misreads.** Scanned PDFs work, but check every number in the review table. English only, and the first 10 pages.
- **Offline needs one online visit first,** and starting a workout needs a connection. Logging sets and finishing don't.
- **Background-tab alerts can arrive late.** Browsers throttle background tabs, though the time shown is always exact. Playing music keeps the tab awake.
- **Calendar export is a snapshot.** Download the `.ics` again after changing your plan or training days; it isn't a live feed.
- **Not built:** streaming-service music (Spotify, Apple Music).
