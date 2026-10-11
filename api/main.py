"""KRATOS API — single user, behind one password.

Run: uvicorn main:app --env-file ../.env   (binds 127.0.0.1 by default)
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from starlette.background import BackgroundTask
from pydantic import AfterValidator, BaseModel, Field, field_validator, model_validator

import ai
import backup
import engine
import pdf_import

DB_PATH = backup.DB
BACKUPS = DB_PATH.parent / "backups"
SNAPSHOT = re.compile(r"kratos-\d{8}T\d{12}Z\.db")
MAX_UPLOAD = 10 * 1024 * 1024

PASSWORD = os.getenv("KRATOS_PASSWORD", "")
if len(PASSWORD) < 12:
    raise SystemExit("Set KRATOS_PASSWORD (12+ characters) in .env. It guards every page and API route.")

SCHEMA = """
CREATE TABLE IF NOT EXISTS profile (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS equipment (id INTEGER PRIMARY KEY, type TEXT NOT NULL, weights_kg TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assessments (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, measured_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
                                  data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES plans(id), day_index INTEGER NOT NULL,
                                     started_at TEXT NOT NULL, completed_at TEXT);
CREATE TABLE IF NOT EXISTS set_logs (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                                     exercise_id TEXT NOT NULL, set_number INTEGER NOT NULL, load_kg REAL NOT NULL, reps INTEGER NOT NULL,
                                     rir INTEGER, logged_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS set_logs_exercise ON set_logs (exercise_id, id);
"""
TABLES = ["profile", "equipment", "assessments", "plans", "sessions", "set_logs"]
MAX_RESTORE = 50 * 1024 * 1024


def db() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    return c


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


with db() as c:
    c.executescript(SCHEMA)
threading.Thread(target=backup.run_daily, daemon=True).start()

app = FastAPI(title="KRATOS", docs_url="/api/docs", openapi_url="/api/openapi.json")


# ---- access: one password gates pages, /api and /api/docs ---------------------------
# The session cookie is an expiry signed with a key derived from the password and a random epoch.
# Changing the password, or "Log out everywhere" (a new epoch), ends every session. The epoch file
# sits beside the DB, not in it, so restoring a backup can't revive old sessions. scrypt makes a
# leaked cookie slow to brute-force offline.
PASSWORD_KEY = hashlib.scrypt(PASSWORD.encode(), salt=b"kratos-session", n=2**14, r=8, p=1)
EPOCH = DB_PATH.with_name("session-epoch")
SESSION_KEY = b""


def load_epoch(rotate: bool = False) -> None:
    global SESSION_KEY
    if rotate or not EPOCH.exists():
        EPOCH.write_text(secrets.token_hex(16))
    SESSION_KEY = hmac.new(PASSWORD_KEY, EPOCH.read_text().encode(), "sha256").digest()


load_epoch()
COOKIE, SESSION_SECONDS = "kratos_session", 30 * 86400
# Browsers fetch the manifest without cookies; the host's health probe has none either.
PUBLIC = {"/login", "/healthz", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"}
# Host headers we serve (blocks DNS rebinding). The host's health probe may use an internal address.
HOSTS = set(os.getenv("KRATOS_HOSTS", "localhost,127.0.0.1").split(","))
# 10 failed logins a minute lock out that address; 100 a minute from anywhere lock out everyone, so a
# botnet can't guess in parallel. Behind a proxy, uvicorn --proxy-headers supplies the real client IP.
FAILS: dict[str, deque[float]] = {}
ALL_FAILS: deque[float] = deque(maxlen=100)

# Same-origin everything except fonts, the pose model and YouTube's player. MediaPipe runs WebAssembly.
CSP = ("default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://www.youtube.com; "
       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; "
       "img-src 'self' data: blob: https://i.ytimg.com; media-src 'self' blob:; connect-src 'self' https://storage.googleapis.com; "
       "frame-src https://www.youtube.com https://www.youtube-nocookie.com; worker-src 'self' blob:; "
       "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",  # YouTube's embed refuses to play without the origin
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=()",
}


def sign(exp: str) -> str:
    return hmac.new(SESSION_KEY, exp.encode(), "sha256").hexdigest()


def logged_in(token: str | None) -> bool:
    exp, _, sig = (token or "").partition(".")
    return hmac.compare_digest(sig.encode(), sign(exp).encode()) and int(exp) > time.time()  # signature first: exp is ours


def locked(d: deque[float]) -> bool:
    return len(d) == d.maxlen and time.monotonic() - d[0] < 60


async def gate(request: Request, call_next):
    path = request.url.path
    if path != "/healthz" and "*" not in HOSTS and request.headers.get("host", "").rsplit(":", 1)[0] not in HOSTS:
        return PlainTextResponse("Invalid host header", 400)
    # Cross-site writes are refused outright; SameSite=Lax already keeps the cookie off most of them.
    origin = request.headers.get("origin")
    if request.method not in ("GET", "HEAD", "OPTIONS") and origin and urllib.parse.urlsplit(origin).netloc != request.headers.get("host"):
        return JSONResponse({"detail": "Cross-site request refused."}, 403)
    if path == "/login" and request.method == "POST":
        size = request.headers.get("content-length", "")
        if not (size.isdigit() and int(size) <= 2048):  # the form is parsed before any check; keep it tiny
            return PlainTextResponse("Request too large.", 413)
    if path in PUBLIC or logged_in(request.cookies.get(COOKIE)):
        return await call_next(request)
    if path.startswith("/api"):
        return JSONResponse({"detail": "Log in first."}, 401)
    return RedirectResponse("/login", 303)


@app.middleware("http")
async def guard(request: Request, call_next):
    r = await gate(request, call_next)
    r.headers.update(SECURITY_HEADERS)
    if request.url.path != "/api/docs":  # Swagger UI runs inline scripts from a CDN
        r.headers["Content-Security-Policy"] = CSP
    if request.url.scheme == "https":
        r.headers["Strict-Transport-Security"] = "max-age=31536000"
    return r


LOGIN_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0a0b0a"><link rel="icon" href="/icon.svg"><link rel="manifest" href="/manifest.webmanifest"><title>Log in · KRATOS</title>
<style>html{color-scheme:dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0a0b0a;color:#eef2ec;font:16px system-ui,sans-serif}
form{width:min(20rem,calc(100% - 2rem));display:grid;gap:.75rem}h1{margin:0 0 .5rem;font-size:1.5rem;letter-spacing:.2em}
input,button{font:inherit;padding:.6rem .75rem;border-radius:.4rem;border:1px solid #2c312d}input{background:#121413;color:inherit}
button{background:#c6f432;color:#0a0b0a;font-weight:600;border:0;cursor:pointer}:focus-visible{outline:2px solid #c6f432;outline-offset:2px}
p{margin:0;color:#ff6a45}</style></head><body><form method="post" action="/login"><h1>KRATOS</h1>
<label for="pw">Password</label><input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>
<!--error--><button>Log in</button></form></body></html>"""


@app.get("/login", include_in_schema=False)
def login_page():
    return HTMLResponse(LOGIN_PAGE)


@app.post("/login", include_in_schema=False)
async def login(request: Request, password: str = Form("")):
    ip = request.client.host if request.client else "?"
    if locked(FAILS.get(ip, deque())) or locked(ALL_FAILS):
        return HTMLResponse(LOGIN_PAGE.replace("<!--error-->", "<p role=alert>Too many attempts. Wait a minute.</p>"), 429)
    if not hmac.compare_digest(password.encode(), PASSWORD.encode()):
        if len(FAILS) > 10_000:  # spoofed addresses can't grow this without bound
            FAILS.clear()
        FAILS.setdefault(ip, deque(maxlen=10)).append(time.monotonic())
        ALL_FAILS.append(time.monotonic())
        return HTMLResponse(LOGIN_PAGE.replace("<!--error-->", "<p role=alert>Wrong password.</p>"), 401)
    exp = str(int(time.time()) + SESSION_SECONDS)
    r = RedirectResponse("/", 303)
    # Anywhere but localhost the cookie is HTTPS-only (the camera needs HTTPS anyway).
    r.set_cookie(COOKIE, f"{exp}.{sign(exp)}", max_age=SESSION_SECONDS, httponly=True, samesite="lax",
                 secure=request.url.hostname not in ("localhost", "127.0.0.1"))
    return r


@app.get("/logout", include_in_schema=False)
def logout():
    r = RedirectResponse("/login", 303)
    r.delete_cookie(COOKIE)
    return r


@app.post("/api/logout-everywhere", status_code=204)
def logout_everywhere():
    """A lost phone: every device, this one included, has to log in again."""
    load_epoch(rotate=True)
    r = Response(status_code=204)
    r.delete_cookie(COOKIE)
    return r


# ---- models (trust boundary) --------------------------------------------------

Limitation = Literal["knee", "shoulder", "lower_back", "wrist", "elbow"]


class Profile(BaseModel):
    age: int = Field(ge=13, le=100)
    height_cm: float = Field(ge=100, le=250)
    weight_kg: float = Field(ge=25, le=350)
    experience: Literal["beginner", "intermediate", "advanced"]
    goal: Literal["muscle_gain", "strength", "fat_loss", "general", "endurance"]
    days_per_week: int = Field(ge=2, le=6)
    session_minutes: int = Field(ge=20, le=120)
    limitations: list[Limitation] = Field(default=[], max_length=5)
    location: Literal["home", "gym"] = "home"
    units: Literal["kg", "lb"] = "kg"


class EquipmentIn(BaseModel):
    type: engine.EquipType
    weights_kg: list[float] = Field(default=[], max_length=120)

    @field_validator("weights_kg")
    @classmethod
    def _weights(cls, v: list[float]) -> list[float]:
        if any(not 0.25 <= w <= 500 for w in v):
            raise ValueError("weights must be between 0.25 and 500 kg")
        return sorted({round(w, 3) for w in v})

    @model_validator(mode="after")
    def _loadable(self):
        if self.type in engine.LOADABLE and not self.weights_kg:
            raise ValueError(f"{self.type} needs at least one weight")
        if self.type not in engine.LOADABLE:
            self.weights_kg = []
        return self


def _known_exercise(v: str) -> str:
    if v not in engine.BY_ID:
        raise ValueError(f"unknown exercise '{v}'")
    return v


ExerciseId = Annotated[str, AfterValidator(_known_exercise)]


def _text(v: str) -> str:
    """Free text is stored and shown back (React escapes it); refuse blanks and control characters."""
    v = v.strip()
    if not v or any(ord(ch) < 32 and ch not in "\n\t" or ch == "\x7f" for ch in v):
        raise ValueError("must be plain, non-blank text")
    return v


Text = Annotated[str, AfterValidator(_text)]


class PlanItem(BaseModel):
    exercise_id: ExerciseId
    sets: int = Field(ge=1, le=10)
    rep_min: int = Field(ge=1, le=300)
    rep_max: int = Field(ge=1, le=300)
    unit: Literal["reps", "sec"] = "reps"
    rest_seconds: int = Field(ge=0, le=600)

    @model_validator(mode="after")
    def _range(self):
        if self.rep_max < self.rep_min:
            raise ValueError("rep_max must be ≥ rep_min")
        return self


class PlanDay(BaseModel):
    name: Text = Field(min_length=1, max_length=40)
    focus: Text = Field(default="custom", max_length=20)
    items: list[PlanItem] = Field(min_length=1, max_length=15)


class PlanIn(BaseModel):
    days: list[PlanDay] = Field(min_length=1, max_length=7)
    split: Text = Field(default="Imported", min_length=1, max_length=60)
    source: Literal["import", "edited"] = "import"


class ChatMsg(BaseModel):
    role: Literal["user", "assistant"]
    content: Text = Field(min_length=1, max_length=2000)


class CoachIn(BaseModel):
    messages: list[ChatMsg] = Field(min_length=1, max_length=12)


class SessionIn(BaseModel):
    plan_id: int
    day_index: int = Field(ge=0, le=6)


class SetIn(BaseModel):
    exercise_id: ExerciseId
    set_number: int = Field(ge=1, le=20)
    load_kg: float = Field(ge=0, le=500)
    reps: int = Field(ge=0, le=600)  # seconds for timed holds
    rir: int | None = Field(default=None, ge=0, le=10)


Cm = Annotated[float, Field(ge=10, le=250)]


class AssessmentIn(BaseModel):
    kind: Literal["manual", "camera"]
    weight_kg: float | None = Field(default=None, ge=25, le=350)
    waist_cm: Cm | None = None
    chest_cm: Cm | None = None
    hips_cm: Cm | None = None
    arm_cm: float | None = Field(default=None, ge=10, le=80)
    thigh_cm: float | None = Field(default=None, ge=20, le=120)
    # camera-derived estimates — never presented as clinical measurements
    shoulder_hip_ratio: float | None = Field(default=None, ge=0.5, le=3)
    leg_torso_ratio: float | None = Field(default=None, ge=0.5, le=4)
    shoulder_width_cm_est: float | None = Field(default=None, ge=15, le=80)
    hip_width_cm_est: float | None = Field(default=None, ge=10, le=70)
    shoulder_tilt_deg: float | None = Field(default=None, ge=-30, le=30)
    hip_tilt_deg: float | None = Field(default=None, ge=-30, le=30)
    head_forward_ratio: float | None = Field(default=None, ge=-1, le=1)
    landmark_quality: float | None = Field(default=None, ge=0, le=1)


# ---- helpers -------------------------------------------------------------------

def load_profile(c) -> dict:
    row = c.execute("SELECT data FROM profile WHERE id = 1").fetchone()
    if not row:
        raise HTTPException(409, "Set up your profile first.")
    return json.loads(row["data"])


def load_equipment(c) -> list[dict]:
    return [{"id": r["id"], "type": r["type"], "weights_kg": json.loads(r["weights_kg"])}
            for r in c.execute("SELECT * FROM equipment ORDER BY id")]


def plan_row(row) -> dict:
    return {"id": row["id"], "version": row["version"], "source": row["source"], "status": row["status"],
            "created_at": row["created_at"], **json.loads(row["data"])}


def save_plan(c, plan: dict, source: str) -> int:
    version = c.execute("SELECT COALESCE(MAX(version), 0) + 1 FROM plans").fetchone()[0]
    c.execute("UPDATE plans SET status = 'archived' WHERE status = 'active'")
    return c.execute("INSERT INTO plans (version, source, status, data, created_at) VALUES (?, ?, 'active', ?, ?)",
                     (version, source, json.dumps(plan), now())).lastrowid


def history(c, exercise_id: str) -> list[dict]:
    rows = c.execute("SELECT session_id, load_kg, reps, rir FROM set_logs WHERE exercise_id = ? ORDER BY id DESC LIMIT 12",
                     (exercise_id,))
    return [dict(r) for r in rows]


def session_or_404(c, session_id: int):
    s = c.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if not s:
        raise HTTPException(404, "Session not found")
    return s


# ---- routes --------------------------------------------------------------------

@app.get("/healthz", include_in_schema=False)
def healthz():
    """Public probe for the host: the app is up and the database on the volume is readable. Reveals nothing else."""
    with db() as c:
        c.execute("SELECT 1 FROM profile LIMIT 1")
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"ok": True, "ai": ai.enabled(), "model": ai.MODEL if ai.enabled() else None}


@app.get("/api/exercises")
def exercises():
    return engine.CATALOG


@app.get("/api/profile")
def get_profile():
    with db() as c:
        row = c.execute("SELECT data FROM profile WHERE id = 1").fetchone()
    return json.loads(row["data"]) if row else None


@app.put("/api/profile")
def put_profile(p: Profile):
    with db() as c:
        c.execute("INSERT INTO profile (id, data, updated_at) VALUES (1, ?, ?) "
                  "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
                  (p.model_dump_json(), now()))
    return p


@app.get("/api/equipment")
def get_equipment():
    with db() as c:
        return load_equipment(c)


@app.post("/api/equipment", status_code=201)
def add_equipment(e: EquipmentIn):
    with db() as c:
        new_id = c.execute("INSERT INTO equipment (type, weights_kg, created_at) VALUES (?, ?, ?)",
                           (e.type, json.dumps(e.weights_kg), now())).lastrowid
    return {"id": new_id, **e.model_dump()}


@app.delete("/api/equipment/{equipment_id}", status_code=204)
def delete_equipment(equipment_id: int):
    with db() as c:
        c.execute("DELETE FROM equipment WHERE id = ?", (equipment_id,))


@app.post("/api/plans/generate", status_code=201)
def generate_plan():
    with db() as c:
        plan = engine.generate(load_profile(c), load_equipment(c))
        if not any(d["items"] for d in plan["days"]):
            raise HTTPException(422, "No exercises fit your equipment and limitations.")
        save_plan(c, plan, "engine")
    return active_plan()


@app.post("/api/plans", status_code=201)
def create_plan(p: PlanIn):
    """Create a plan from user-reviewed items (a PDF import or an edited copy). Older versions are kept."""
    with db() as c:
        save_plan(c, {"split": p.split, "days": [d.model_dump() for d in p.days], "warnings": []}, p.source)
    return active_plan()


@app.get("/api/plans")
def list_plans():
    with db() as c:
        return [{"id": r["id"], "version": r["version"], "source": r["source"], "status": r["status"], "created_at": r["created_at"],
                 "split": json.loads(r["data"])["split"], "days": [d["name"] for d in json.loads(r["data"])["days"]]}
                for r in c.execute("SELECT * FROM plans ORDER BY version DESC")]


@app.post("/api/plans/{plan_id}/activate")
def activate_plan(plan_id: int):
    with db() as c:
        if not c.execute("SELECT 1 FROM plans WHERE id = ?", (plan_id,)).fetchone():
            raise HTTPException(404, "Plan not found")
        c.execute("UPDATE plans SET status = CASE WHEN id = ? THEN 'active' ELSE 'archived' END", (plan_id,))
    return active_plan()


@app.get("/api/plans/active")
def active_plan():
    with db() as c:
        row = c.execute("SELECT * FROM plans WHERE status = 'active' ORDER BY id DESC LIMIT 1").fetchone()
        if not row:
            raise HTTPException(404, "No active plan")
        plan, equipment = plan_row(row), load_equipment(c)
        for day in plan["days"]:
            for item in day["items"]:
                item["rx"] = engine.prescribe(item, equipment, history(c, item["exercise_id"]))
    return plan


@app.post("/api/plans/{plan_id}/explain")
def explain_plan(plan_id: int):
    if not ai.enabled():
        raise HTTPException(503, "AI isn't configured — set KRATOS_LLM_API_KEY in .env.")
    with db() as c:
        row = c.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Plan not found")
        profile, plan = load_profile(c), plan_row(row)
        owned = sorted({e["type"] for e in load_equipment(c)})
    # Minimal payload: no body measurements, age or history leave the machine.
    context = {
        "goal": profile["goal"], "experience": profile["experience"], "days_per_week": profile["days_per_week"],
        "session_minutes": profile["session_minutes"], "limitations": profile["limitations"], "equipment": owned,
        "split": plan["split"],
        "days": [{"name": d["name"], "exercises": [
            {"name": engine.BY_ID[i["exercise_id"]]["name"], "sets": i["sets"], "reps": f"{i['rep_min']}-{i['rep_max']} {i['unit']}",
             "rest_seconds": i["rest_seconds"]} for i in d["items"]]} for d in plan["days"]],
    }
    try:
        return {"text": ai.explain_plan(context)}
    except ai.AIError as e:
        raise HTTPException(502, str(e))


@app.post("/api/coach")
def coach(q: CoachIn):
    if not ai.enabled():
        raise HTTPException(503, "AI isn't configured — set KRATOS_LLM_API_KEY in .env.")
    with db() as c:
        profile = load_profile(c)
        owned = sorted({e["type"] for e in load_equipment(c)})
        row = c.execute("SELECT data FROM plans WHERE status = 'active' ORDER BY id DESC LIMIT 1").fetchone()
    plan = json.loads(row["data"]) if row else None
    # Same minimisation as /explain: training context only, no body measurements or history.
    context = {
        "goal": profile["goal"], "experience": profile["experience"], "days_per_week": profile["days_per_week"],
        "session_minutes": profile["session_minutes"], "limitations": profile["limitations"], "equipment": owned,
        "plan": [{"day": d["name"], "exercises": [engine.BY_ID[i["exercise_id"]]["name"] for i in d["items"]]} for d in plan["days"]] if plan else None,
    }
    try:
        return {"text": ai.coach(context, [m.model_dump() for m in q.messages])}
    except ai.AIError as e:
        raise HTTPException(502, str(e))


YOUTUBE_ID = re.compile(r"[A-Za-z0-9_-]{11}")


@app.get("/api/youtube/title")
def youtube_title(id: str):
    """Title for a YouTube video via its public oEmbed endpoint (fixed host, validated id — no SSRF surface)."""
    if not YOUTUBE_ID.fullmatch(id):
        raise HTTPException(422, "Invalid YouTube video id")
    url = "https://www.youtube.com/oembed?format=json&url=" + urllib.parse.quote(f"https://www.youtube.com/watch?v={id}", safe="")
    try:
        with urllib.request.urlopen(url, timeout=8) as r:
            d = json.load(r)
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise HTTPException(502, "YouTube didn't return details for that video (private, removed or offline).")
    return {"title": str(d.get("title", ""))[:200], "author": str(d.get("author_name", ""))[:120]}


@app.post("/api/sessions", status_code=201)
def start_session(s: SessionIn):
    with db() as c:
        row = c.execute("SELECT data FROM plans WHERE id = ?", (s.plan_id,)).fetchone()
        if not row or s.day_index >= len(json.loads(row["data"])["days"]):
            raise HTTPException(404, "Plan day not found")
        new_id = c.execute("INSERT INTO sessions (plan_id, day_index, started_at) VALUES (?, ?, ?)",
                           (s.plan_id, s.day_index, now())).lastrowid
    return {"id": new_id, "plan_id": s.plan_id, "day_index": s.day_index}


@app.get("/api/sessions/open")
def open_session():
    """The unfinished workout from the last 12 hours, so another device (or the iPhone home-screen app,
    which doesn't share Safari's storage) resumes it instead of starting over."""
    cutoff = datetime.fromtimestamp(time.time() - 12 * 3600, timezone.utc).isoformat(timespec="seconds")
    with db() as c:
        row = c.execute("SELECT id, plan_id, day_index FROM sessions WHERE completed_at IS NULL AND started_at > ? "
                        "ORDER BY id DESC LIMIT 1", (cutoff,)).fetchone()
    return dict(row) if row else None


@app.get("/api/sessions/{session_id}")
def get_session(session_id: int):
    with db() as c:
        s = session_or_404(c, session_id)
        sets = [dict(r) for r in c.execute("SELECT * FROM set_logs WHERE session_id = ? ORDER BY id", (session_id,))]
    return {**dict(s), "sets": sets}


@app.post("/api/sessions/{session_id}/sets", status_code=201)
def log_set(session_id: int, s: SetIn):
    with db() as c:
        if session_or_404(c, session_id)["completed_at"]:
            raise HTTPException(409, "Session already completed")
        # A retry after a lost response (flaky gym wifi) resends the same set number: update that set, don't log it twice.
        dup = c.execute("SELECT id FROM set_logs WHERE session_id = ? AND exercise_id = ? AND set_number = ?",
                        (session_id, s.exercise_id, s.set_number)).fetchone()
        if dup:
            new_id = dup["id"]
            c.execute("UPDATE set_logs SET load_kg = ?, reps = ?, rir = ? WHERE id = ?", (s.load_kg, s.reps, s.rir, new_id))
        else:
            new_id = c.execute("INSERT INTO set_logs (session_id, exercise_id, set_number, load_kg, reps, rir, logged_at) "
                               "VALUES (?, ?, ?, ?, ?, ?, ?)",
                               (session_id, s.exercise_id, s.set_number, s.load_kg, s.reps, s.rir, now())).lastrowid
    return {"id": new_id, **s.model_dump()}


@app.delete("/api/sessions/{session_id}/sets/{set_id}", status_code=204)
def delete_set(session_id: int, set_id: int):
    with db() as c:
        c.execute("DELETE FROM set_logs WHERE id = ? AND session_id = ?", (set_id, session_id))


@app.post("/api/sessions/{session_id}/complete")
def complete_session(session_id: int):
    with db() as c:
        session_or_404(c, session_id)
        c.execute("UPDATE sessions SET completed_at = COALESCE(completed_at, ?) WHERE id = ?", (now(), session_id))
    return {"ok": True}


@app.get("/api/assessments")
def list_assessments():
    with db() as c:
        return [{"id": r["id"], "kind": r["kind"], "measured_at": r["measured_at"], **json.loads(r["data"])}
                for r in c.execute("SELECT * FROM assessments ORDER BY measured_at DESC LIMIT 200")]


@app.post("/api/assessments", status_code=201)
def add_assessment(a: AssessmentIn):
    data = a.model_dump(exclude_none=True, exclude={"kind"})
    if not data:
        raise HTTPException(422, "Nothing to save.")
    with db() as c:
        new_id = c.execute("INSERT INTO assessments (kind, data, measured_at) VALUES (?, ?, ?)",
                           (a.kind, json.dumps(data), now())).lastrowid
        if a.weight_kg:  # keep the profile's body weight current
            row = c.execute("SELECT data FROM profile WHERE id = 1").fetchone()
            if row:
                c.execute("UPDATE profile SET data = ? WHERE id = 1", (json.dumps({**json.loads(row["data"]), "weight_kg": a.weight_kg}),))
    return {"id": new_id}


@app.delete("/api/assessments/{assessment_id}", status_code=204)
def delete_assessment(assessment_id: int):
    with db() as c:
        c.execute("DELETE FROM assessments WHERE id = ?", (assessment_id,))


@app.post("/api/imports/pdf")
async def import_pdf(file: UploadFile = File(...), use_ai: bool = Form(False)):
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "PDF is larger than 10 MB.")
    try:
        text = pdf_import.extract_text(data)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except Exception:  # pypdf raises a zoo of errors on malformed files
        raise HTTPException(422, "Couldn't read that PDF.")
    warnings = []
    if not text.strip():
        raise HTTPException(422, "No text found — this looks like a scanned PDF. OCR isn't supported yet.")
    if use_ai:
        if not ai.enabled():
            raise HTTPException(503, "AI isn't configured — set KRATOS_LLM_API_KEY in .env.")
        try:
            days = pdf_import.from_ai(ai.parse_workout(text).days)
        except ai.AIError as e:
            raise HTTPException(502, str(e))
    else:
        days = pdf_import.parse_text(text)
    if not days:
        warnings.append("No sets × reps lines found. Try the AI option, or check the PDF has selectable text.")
    # The PDF itself is never stored; only this draft goes back for review.
    with db() as c:
        owned = {e["type"] for e in load_equipment(c)}
        prof = c.execute("SELECT data FROM profile WHERE id = 1").fetchone()
    profile = {"experience": "beginner", "goal": "general", "limitations": [], **(json.loads(prof["data"]) if prof else {})}
    for d in days:
        for item in d["items"]:
            ex = engine.BY_ID.get(item["exercise_id"])
            item["usable"] = bool(ex) and engine.usable(ex, owned, profile["limitations"])
            item["swap"] = engine.substitute(ex["id"], owned, profile) if ex and not item["usable"] else None
    return {"days": days, "warnings": warnings, "chars": len(text)}


@app.get("/api/progress")
def progress():
    with db() as c:
        weights = [{"date": r["measured_at"], "kg": json.loads(r["data"])["weight_kg"]}
                   for r in c.execute("SELECT * FROM assessments ORDER BY measured_at")
                   if "weight_kg" in json.loads(r["data"])]
        rows = c.execute("SELECT s.exercise_id, s.load_kg, s.reps, s.rir, se.started_at, se.id AS sid FROM set_logs s "
                         "JOIN sessions se ON se.id = s.session_id WHERE s.load_kg > 0 AND s.reps > 0 ORDER BY se.started_at").fetchall()
        sessions = [dict(r) for r in c.execute("SELECT id, started_at, completed_at FROM sessions WHERE completed_at IS NOT NULL ORDER BY started_at")]
        volume = c.execute("SELECT COUNT(*) AS sets, COALESCE(SUM(load_kg * reps), 0) AS kg FROM set_logs").fetchone()
        bw_best = c.execute("SELECT s.exercise_id, MAX(s.reps) AS reps, se.started_at FROM set_logs s JOIN sessions se ON se.id = s.session_id "
                            "WHERE s.load_kg = 0 AND s.reps > 0 GROUP BY s.exercise_id").fetchall()
    lifts: dict[str, dict] = {}
    for r in rows:  # best estimated 1RM per exercise per session
        pts = lifts.setdefault(r["exercise_id"], {})
        rm = engine.e1rm(r["load_kg"], r["reps"], r["rir"])
        if rm > pts.get(r["sid"], (0, ""))[0]:
            pts[r["sid"]] = (rm, r["started_at"])
    records = [{"exercise_id": k, "name": engine.BY_ID[k]["name"], "kind": "e1rm", "value": round(v, 1), "date": d}
               for k, pts in lifts.items() for v, d in [max(pts.values())]]
    records += [{"exercise_id": r["exercise_id"], "name": engine.BY_ID[r["exercise_id"]]["name"],
                 "kind": "sec" if engine.BY_ID[r["exercise_id"]].get("timed") else "reps", "value": r["reps"], "date": r["started_at"]}
                for r in bw_best]
    return {
        "records": sorted(records, key=lambda r: r["name"]),
        "weights": weights,
        "lifts": [{"exercise_id": k, "name": engine.BY_ID[k]["name"],
                   "points": [{"date": d, "e1rm": round(v, 1)} for v, d in pts.values()]} for k, pts in lifts.items()],
        "sessions": sessions,
        "totals": {"sets": volume["sets"], "volume_kg": round(volume["kg"])},
    }


@app.get("/api/export")
def export():
    with db() as c:
        return {t: [dict(r) for r in c.execute(f"SELECT * FROM {t}")] for t in TABLES}  # noqa: S608 — fixed names


@app.get("/api/backup")
def download_backup():
    """A fresh, verified snapshot to keep off the server (the daily ones share the DB's disk)."""
    fd, name = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    path = backup.snapshot(Path(name))
    return FileResponse(path, media_type="application/vnd.sqlite3", filename=f"kratos-{datetime.now(timezone.utc):%Y-%m-%d}.db",
                        background=BackgroundTask(path.unlink, missing_ok=True))


@app.get("/api/backups")
def list_backups():
    return [{"name": p.name, "bytes": p.stat().st_size, "taken_at": datetime.fromtimestamp(p.stat().st_mtime, timezone.utc).isoformat(timespec="seconds")}
            for p in sorted(BACKUPS.glob("kratos-*.db"), reverse=True)]


def restore_bytes(data: bytes) -> dict:
    fd, name = tempfile.mkstemp(suffix=".db")
    tmp = Path(name)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        try:
            backup.check(tmp)
        except sqlite3.DatabaseError:
            raise HTTPException(422, "That file isn't a usable KRATOS backup (damaged, or from something else). Nothing was changed.")
        backup.backup()  # today's data becomes the newest snapshot, so a wrong restore is one click to undo
        backup.restore(tmp)
    finally:
        tmp.unlink(missing_ok=True)
    with db() as c:
        c.executescript(SCHEMA)  # an older backup gains the tables added since
        return {t: c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in TABLES}  # noqa: S608 — fixed names


@app.post("/api/backups/{name}/restore")
def restore_snapshot(name: str):
    if not SNAPSHOT.fullmatch(name) or not (BACKUPS / name).is_file():
        raise HTTPException(404, "Backup not found")
    return restore_bytes((BACKUPS / name).read_bytes())  # read first: the safety snapshot may prune this file


@app.post("/api/restore")
async def restore_upload(file: UploadFile = File(...)):
    data = await file.read(MAX_RESTORE + 1)
    if len(data) > MAX_RESTORE:
        raise HTTPException(413, "Backup is larger than 50 MB.")
    return restore_bytes(data)


@app.delete("/api/data", status_code=204)
def delete_all():
    backup.backup()  # "Delete everything" by mistake is recoverable from Settings → Backups
    with db() as c:
        c.executescript("".join(f"DELETE FROM {t};" for t in reversed(TABLES)))  # children before parents
    with db() as c:
        c.execute("VACUUM")  # actually drop the deleted pages from the file


# Production: serve the built frontend from this process (`npm run build` in web/).
# Real files (assets, wasm, icons) are served as-is; every other non-API path gets index.html,
# so client routes like /train/library survive refreshes and deep links.
WEB_DIST = (Path(__file__).parent.parent / "web" / "dist").resolve()


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    if path == "api" or path.startswith("api/"):
        raise HTTPException(404, "Not found")
    if not (WEB_DIST / "index.html").exists():
        raise HTTPException(404, "UI not built — run `npm run build` in web/ (or use ./start.sh).")
    f = (WEB_DIST / path).resolve()
    if path and f.is_file() and f.is_relative_to(WEB_DIST):  # resolve() + is_relative_to blocks ../ traversal
        return FileResponse(f)
    return FileResponse(WEB_DIST / "index.html")
