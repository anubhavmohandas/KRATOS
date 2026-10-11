# KRATOS

Personal fitness intelligence. Plans are built from the equipment you actually own, and loads are calibrated from the sets you log. You also get:
- a 3D trainer for every exercise
- camera rep counting and body assessment that run on your device
- a music player and timer suite that follow you through the workout
- PDF workout import

Single user, behind one password. Workouts and body data live in `api/kratos.db`, with a daily snapshot in `api/backups/`. Music lives in your browser.

## Run

```sh
./start.sh            # first run installs everything → http://localhost:8000
```

Set `KRATOS_PASSWORD` (12+ characters) in `.env` first, and once per clone run `git config core.hooksPath .githooks` so a commit can never carry `.env` or an API key. The API refuses to start without it. The password guards every page and API route, `/api/docs` included.

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

Backups run inside the API: when the newest snapshot is over a day old, it takes a new one and verifies it restores. The last 14 are kept, on the same disk as the DB, so copy `/data/backups` elsewhere or download `/api/export` to survive losing that disk. To restore a snapshot, run `python backup.py restore /data/backups/<file>` and restart the API.

Camera features need `localhost` or HTTPS, so opening the app from your phone over the LAN needs HTTPS. Install it as an app from the browser's install button (PWA manifest included).

## Pages

| Path | What's there |
|---|---|
| `/` | Dashboard: today's workout, duration, weekly consistency, music, timers, records |
| `/train` · `/train/library` · `/train/versions` | Plan and workout player · all 45 exercises in 3D · plan history (edits and imports never overwrite) |
| `/coach` | Ask KRATOS (LLM), goals, profile, limitations, equipment |
| `/body` | Hands-free front/side camera scan (auto-captures when you're in position, with voice cues), tape and scale measurements, history |
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
| Music | One app-wide `<audio>` for your files (IndexedDB, lock-screen controls) plus YouTube's official embedded player for links. It streams, never downloads, and stays visible while playing, as YouTube's terms require | `web/src/music/` |

If an exercise has no history yet, KRATOS asks for a calibration set instead of inventing a load.

## Map

```
.env / .env.example   configuration (AI key, model, DB path)
api/
  main.py             routes, SQLite schema, validation at every input, SPA fallback
  engine.py           plan generation + load prescription
  exercises.json      curated catalog (equipment, contraindications, cues, animation, rep-counter profile)
  pdf_import.py       PDF text → sets×reps rows → fuzzy catalog match
  backup.py           daily SQLite snapshots, restore
  ai.py               OpenAI-compatible client (NVIDIA NIM default)
web/src/
  main.tsx, router.tsx  shell + History-API routing
  pages/              Dashboard · Train (+ Session, Library) · Coach · Body · Progress · Space
  trainer/ vision/ timer/ music/
```

To add an exercise, add one entry to `exercises.json`. Reuse an existing `anim`, or add keyframes in `web/src/trainer/anims.ts`.

## Checks

```sh
cd api && .venv/bin/python test_engine.py && .venv/bin/python pdf_import.py && .venv/bin/python ai.py
cd api && .venv/bin/python test_api.py && .venv/bin/python backup.py test
cd web && npm test && npx tsc
```

`test_engine.py` generates about 64k plan items across equipment sets, splits, goals and limitations. It asserts that none needs equipment you don't own, hits an excluded limitation, or triggers a false "no exercise fits" warning. `ai.py` checks that AI-parsed plans drop bad items without rejecting the rest, and that a 429, bad key, outage, dropped connection, timeout or junk reply from the provider each becomes a clear error. `test_api.py` starts a real server and checks that every route is gated, that forged and expired cookies are refused, and that login is throttled. It then runs the core journey with the AI provider down: plan, a resent set (stored once), undo, resume, finish, progress, a corrupt PDF and delete-all. `backup.py test` checks the snapshot, prune and restore cycle. `npm test` covers the rep counter, body metrics, scan positioning cues, timer maths, and that every exercise has its own 3D animation.

## Honest limits

- **Body metrics are estimates:** joint-centre widths calibrated from your height, ratios and tilt. There's no body-fat %, because a webcam can't measure it reliably.
- **Rep-counter thresholds are fixed per movement** (`vision/metrics.ts` → `PROFILES`). Film from the side, and tune them if your angle reads differently.
- **Scanned PDFs aren't supported yet** (no OCR).
- **Background-tab alerts can arrive late.** Browsers throttle background tabs, though the time shown is always exact. Playing music keeps the tab awake.
- **Not built yet:** training calendar, recovery check-ins, nutrition, offline mode, streaming-service music.
