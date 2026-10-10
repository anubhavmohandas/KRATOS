# KRATOS

Personal fitness intelligence. Plans are built from the equipment you actually own, and loads are calibrated from the sets you log. You also get:
- a 3D trainer for every exercise
- camera rep counting and body assessment that run on your device
- a music player and timer suite that follow you through the workout
- PDF workout import

Single user, local-first. Workouts and body data live in `api/kratos.db`; music lives in your browser.

## Run

```sh
./start.sh            # first run installs everything → http://localhost:8000
```

Development with hot reload (two terminals):

```sh
cd api && .venv/bin/uvicorn main:app --env-file ../.env --reload   # API on :8000
cd web && npm run dev                                               # UI on :5173, proxies /api
```

**Configuration lives in `.env` at the project root** (created from `.env.example` on first run, gitignored). AI is optional. Set `KRATOS_LLM_API_KEY` (or `NVIDIA_API_KEY`) to enable "Why this plan?", Ask KRATOS and AI parsing for messy PDFs. The default provider is NVIDIA NIM; any OpenAI-compatible endpoint works via `KRATOS_LLM_BASE_URL` / `KRATOS_LLM_MODEL`.

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
  ai.py               OpenAI-compatible client (NVIDIA NIM default)
web/src/
  main.tsx, router.tsx  shell + History-API routing
  pages/              Dashboard · Train (+ Session, Library) · Coach · Body · Progress · Space
  trainer/ vision/ timer/ music/
```

To add an exercise, add one entry to `exercises.json`. Reuse an existing `anim`, or add keyframes in `web/src/trainer/anims.ts`.

## Checks

```sh
cd api && .venv/bin/python test_engine.py && .venv/bin/python pdf_import.py
cd web && npm test && npx tsc
```

`test_engine.py` generates about 64k plan items across equipment sets, splits, goals and limitations. It asserts that none needs equipment you don't own, hits an excluded limitation, or triggers a false "no exercise fits" warning. `npm test` covers the rep counter, body metrics and timer maths.

## Honest limits

- **Body metrics are estimates:** joint-centre widths calibrated from your height, ratios and tilt. There's no body-fat %, because a webcam can't measure it reliably.
- **Rep-counter thresholds are fixed per movement** (`vision/metrics.ts` → `PROFILES`). Film from the side, and tune them if your angle reads differently.
- **Scanned PDFs aren't supported yet** (no OCR).
- **Background-tab alerts can arrive late.** Browsers throttle background tabs, though the time shown is always exact. Playing music keeps the tab awake.
- **Not built yet:** training calendar, recovery check-ins, nutrition, offline mode, streaming-service music.
- **No auth.** The API binds to 127.0.0.1 and rejects foreign Host headers. Add auth before exposing it beyond localhost.
