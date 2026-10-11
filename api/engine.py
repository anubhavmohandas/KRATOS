"""Deterministic workout engine.

The LLM never picks exercises, sets, reps or loads — this module does, from the
user's profile, owned equipment and logged sets.
"""
import json
import math
from pathlib import Path
from typing import Literal, get_args

EquipType = Literal["dumbbells", "kettlebell", "barbell", "rack", "bench", "pull_up_bar", "dip_bars", "bands", "cable"]
EQUIPMENT = get_args(EquipType)
LOADABLE = {"dumbbells", "kettlebell", "barbell", "cable"}  # these carry a list of available weights

CATALOG: list[dict] = json.loads((Path(__file__).parent / "exercises.json").read_text())
BY_ID = {e["id"]: e for e in CATALOG}

GOALS = {  # sets, rep_min, rep_max, rest_seconds
    "strength": (4, 4, 6, 180),
    "muscle_gain": (3, 8, 12, 90),
    "general": (3, 8, 12, 75),
    "fat_loss": (3, 10, 15, 60),
    "endurance": (3, 15, 20, 45),
}
LEVEL = {"beginner": 1, "intermediate": 2, "advanced": 3}
SPLITS = {
    2: ["full", "full"],
    3: ["full", "full", "full"],
    4: ["upper", "lower", "upper", "lower"],
    5: ["upper", "lower", "push", "pull", "legs"],
    6: ["push", "pull", "legs", "push", "pull", "legs"],
}
SPLIT_NAMES = {2: "Full body ×2", 3: "Full body ×3", 4: "Upper / Lower", 5: "Upper / Lower / Push / Pull / Legs", 6: "Push / Pull / Legs ×2"}
# Slots in priority order — when the session runs out of time, the tail is dropped.
SLOTS = {
    "full": ["squat", "h_push", "v_pull", "hinge", "h_pull", "v_push", "core", "lunge"],
    "upper": ["h_push", "h_pull", "v_push", "v_pull", "biceps", "triceps", "core"],
    "lower": ["squat", "hinge", "lunge", "core", "hinge"],
    "push": ["h_push", "v_push", "h_push", "triceps", "core"],
    "pull": ["v_pull", "h_pull", "v_pull", "biceps", "core"],
    "legs": ["squat", "hinge", "lunge", "core", "squat"],
}
DAY_NAMES = {"full": "Full Body", "upper": "Upper", "lower": "Lower", "push": "Push", "pull": "Pull", "legs": "Legs"}
PATTERN_NAMES = {
    "squat": "squat", "hinge": "hip hinge", "lunge": "lunge", "h_push": "horizontal push", "v_push": "overhead push",
    "h_pull": "horizontal pull (row)", "v_pull": "vertical pull", "core": "core", "biceps": "biceps", "triceps": "triceps",
}
HINTS = {
    "h_pull": " Resistance bands or a pair of dumbbells would cover it.",
    "v_pull": " A doorway pull-up bar or resistance bands would cover it.",
}
ISOLATION = {"biceps", "triceps", "core"}
DEFAULT_RIR = 2  # assumed reps-in-reserve when a set is logged without one


def usable(ex: dict, owned: set, limitations: list) -> bool:
    return set(ex["needs"]) <= owned and not set(ex["avoid"]) & set(limitations)


def _score(ex: dict, profile: dict) -> float:
    s = -abs(ex["level"] - LEVEL[profile["experience"]]) * 2
    if ex["load"] and profile["goal"] in ("strength", "muscle_gain"):
        s += 1
    if ex["load"] == "barbell" and profile["goal"] == "strength":
        s += 1
    if ex.get("timed") and ex["pattern"] != "core":
        s -= 1
    return s


def candidates(pattern: str, owned: set, profile: dict) -> list[dict]:
    pool = [e for e in CATALOG if e["pattern"] == pattern and usable(e, owned, profile["limitations"])]
    return sorted(pool, key=lambda e: _score(e, profile), reverse=True)  # stable: ties keep catalog order


def substitute(exercise_id: str, owned: set, profile: dict) -> str | None:
    """Best same-pattern exercise the user can actually do."""
    pool = candidates(BY_ID[exercise_id]["pattern"], owned, profile)
    return pool[0]["id"] if pool else None


def _item(ex: dict, profile: dict) -> dict:
    sets, lo, hi, rest = GOALS[profile["goal"]]
    if profile["experience"] == "beginner":
        sets = max(2, sets - 1)
    if ex.get("timed"):
        lvl = LEVEL[profile["experience"]]
        return {"exercise_id": ex["id"], "sets": sets, "rep_min": 15 + 15 * lvl, "rep_max": 30 + 15 * lvl, "unit": "sec", "rest_seconds": 60}
    if ex["pattern"] in ISOLATION:
        lo, hi, rest = max(lo, 10), max(hi, 15), min(rest, 75)
    return {"exercise_id": ex["id"], "sets": sets, "rep_min": lo, "rep_max": hi, "unit": "reps", "rest_seconds": rest}


def generate(profile: dict, equipment: list[dict]) -> dict:
    owned = {e["type"] for e in equipment}
    kinds = SPLITS[profile["days_per_week"]]
    budget = profile["session_minutes"] * 60 - 300  # 5 min warm-up
    days, warnings, seen = [], [], {}
    if profile["limitations"]:
        warnings.append(
            "Exercises that commonly aggravate your " + ", ".join(l.replace("_", " ") for l in profile["limitations"])
            + " were left out. This isn't medical advice — get any pain checked by a professional."
        )
    for kind in kinds:
        letter = chr(65 + sum(1 for d in days if d["focus"] == kind))
        items, used, spent = [], set(), 0
        for pattern in SLOTS[kind]:
            options = candidates(pattern, owned, profile)
            if not options:
                msg = f"No {PATTERN_NAMES[pattern]} exercise fits your equipment and limitations.{HINTS.get(pattern, '')}"
                if msg not in warnings:
                    warnings.append(msg)
                continue
            pool = [e for e in options if e["id"] not in used]
            if not pool:  # a repeated slot with no second variation — just skip it
                continue
            # Rotate variations of the same difficulty across repeated day types.
            best = _score(pool[0], profile)
            tier = [e for e in pool if _score(e, profile) >= best - 0.5]
            k = seen.get((kind, pattern), 0)
            seen[(kind, pattern)] = k + 1
            item = _item(tier[k % len(tier)], profile)
            cost = item["sets"] * (40 + item["rest_seconds"]) + 60
            if spent + cost > budget and len(items) >= 3:
                break
            items.append(item)
            used.add(item["exercise_id"])
            spent += cost
        name = DAY_NAMES[kind] + (f" {letter}" if kinds.count(kind) > 1 else "")
        days.append({"name": name, "focus": kind, "items": items})
    return {"split": SPLIT_NAMES[profile["days_per_week"]], "days": days, "warnings": warnings}


# ---- load prescription --------------------------------------------------------

def e1rm(load_kg: float, reps: int, rir: int | None) -> float:
    # occam: Epley; decent for 3–15 reps, rough beyond — swap for an RPE table if precision matters.
    return load_kg * (1 + min(reps + (DEFAULT_RIR if rir is None else rir), 20) / 30)


def reps_at(rm: float, load_kg: float) -> int:
    """Predicted reps to failure at a load, inverse Epley."""
    return max(0, math.floor(30 * (rm / load_kg - 1) + 1e-9))


def prescribe(item: dict, equipment: list[dict], history: list[dict]) -> dict:
    """Today's load and rep target from logged sets (newest first) and owned weights."""
    ex = BY_ID[item["exercise_id"]]
    weights = sorted({w for e in equipment if e["type"] == ex["load"] for w in e["weights_kg"]})
    rx = {"load_kg": None, "reps": item["rep_max"], "note": None, "table": []}
    if item["unit"] == "sec" or not weights:
        last = [s for s in history if s["session_id"] == history[0]["session_id"]] if history else []
        if last and all(s["reps"] >= item["rep_max"] for s in last):
            rx["note"] = "You hit the top of the range last time — add reps or move to a harder variation."
        return rx
    loaded = [s for s in history if s["load_kg"] and s["reps"]]
    if not loaded:
        rx["note"] = (f"Calibration set: pick a weight you could lift about {item['rep_max'] + 2} times and log it. "
                      "KRATOS predicts reps for every weight you own from there.")
        return rx
    rm = max(e1rm(s["load_kg"], s["reps"], s["rir"]) for s in loaded)
    fits = [w for w in weights if reps_at(rm, w) - DEFAULT_RIR >= item["rep_min"]]
    if fits:
        load = fits[-1]
        reps = min(item["rep_max"], reps_at(rm, load) - DEFAULT_RIR)
        if load == weights[-1] and reps_at(rm, load) - DEFAULT_RIR > item["rep_max"] + 5:
            rx["note"] = "Your heaviest weight is light for this range — slow the lowering to 3 s or switch to a single-arm/leg variation."
    else:
        load = weights[0]
        reps = max(1, reps_at(rm, load) - DEFAULT_RIR)
        rx["note"] = "Your lightest weight is heavy for this rep range — do what you can with clean form."
    rx.update(load_kg=load, reps=reps, e1rm=round(rm, 1),
              table=[{"load_kg": w, "reps": reps_at(rm, w)} for w in weights if 1 <= reps_at(rm, w) <= 40])
    return rx


def readiness(sleep_h: float, soreness: int, energy: int, stress: int) -> dict:
    """0–100 from last night's sleep and how you feel (1–5 each). A nudge from your own answers, not a measurement."""
    parts = {"sleep": (min(sleep_h, 8) - 4) / 4, "energy": (energy - 1) / 4, "soreness": (5 - soreness) / 4, "stress": (5 - stress) / 4}
    score = round(100 * sum(w * max(0.0, parts[k]) for k, w in READINESS_WEIGHTS.items()))
    advice = next(text for floor, text in READINESS_ADVICE if score >= floor)
    return {"score": score, "advice": advice}


READINESS_WEIGHTS = {"sleep": 0.35, "energy": 0.25, "soreness": 0.25, "stress": 0.15}
READINESS_ADVICE = [
    (70, "Ready: train as planned."),
    (45, "Train, but keep an extra rep in reserve and end a set early if form slips."),
    (0, "Go light today: one set fewer per exercise and 3+ reps in reserve, or take a rest day."),
]
