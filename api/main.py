"""KRATOS API — single user, local-first.

Run: uvicorn main:app --env-file ../.env   (binds 127.0.0.1 by default)
"""
import json
import os
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse
from pydantic import AfterValidator, BaseModel, Field, field_validator, model_validator

import ai
import engine
import pdf_import

DB_PATH = os.getenv("KRATOS_DB", str(Path(__file__).parent / "kratos.db"))
MAX_UPLOAD = 10 * 1024 * 1024

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


def db() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    return c


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


with db() as c:
    c.executescript(SCHEMA)

app = FastAPI(title="KRATOS", docs_url="/api/docs", openapi_url="/api/openapi.json")
# Local-only app: reject DNS-rebinding requests that arrive with a foreign Host header.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=os.getenv("KRATOS_HOSTS", "localhost,127.0.0.1").split(","))


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
    name: str = Field(min_length=1, max_length=40)
    focus: str = Field(default="custom", max_length=20)
    items: list[PlanItem] = Field(min_length=1, max_length=15)


class PlanIn(BaseModel):
    days: list[PlanDay] = Field(min_length=1, max_length=7)
    split: str = Field(default="Imported", min_length=1, max_length=60)
    source: Literal["import", "edited"] = "import"


class ChatMsg(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=2000)


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
        tables = ["profile", "equipment", "assessments", "plans", "sessions", "set_logs"]
        return {t: [dict(r) for r in c.execute(f"SELECT * FROM {t}")] for t in tables}  # noqa: S608 — fixed names


@app.delete("/api/data", status_code=204)
def delete_all():
    with db() as c:
        c.executescript("DELETE FROM set_logs; DELETE FROM sessions; DELETE FROM plans; DELETE FROM assessments; "
                        "DELETE FROM equipment; DELETE FROM profile;")
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
