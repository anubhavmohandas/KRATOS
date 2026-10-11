"""Run: .venv/bin/python test_engine.py — exits non-zero on the first broken invariant."""
import itertools

import engine

GEAR = [
    [],
    [{"type": "pull_up_bar", "weights_kg": []}],
    [{"type": "dumbbells", "weights_kg": [2.5, 5, 7.5, 10]}],
    [{"type": "dumbbells", "weights_kg": list(range(2, 21, 2))}, {"type": "pull_up_bar", "weights_kg": []}, {"type": "bench", "weights_kg": []}],
    [{"type": "bands", "weights_kg": []}, {"type": "kettlebell", "weights_kg": [12, 16]}],
    [{"type": t, "weights_kg": [20, 40, 60] if t in engine.LOADABLE else []} for t in engine.EQUIPMENT],  # commercial gym
]

checked = 0
for gear, days, goal, exp, lim, minutes in itertools.product(
        GEAR, range(2, 7), engine.GOALS, engine.LEVEL, [[], ["knee"], ["shoulder", "lower_back", "wrist"]], [20, 45, 90]):
    profile = {"days_per_week": days, "goal": goal, "experience": exp, "limitations": lim, "session_minutes": minutes}
    plan = engine.generate(profile, gear)
    owned = {g["type"] for g in gear}
    assert len(plan["days"]) == days
    for day in plan["days"]:
        ids = [i["exercise_id"] for i in day["items"]]
        assert len(ids) == len(set(ids)), f"duplicate exercise in a day: {ids}"
        assert day["items"], f"empty day for {profile} / {owned}"
        for i in day["items"]:
            ex = engine.BY_ID[i["exercise_id"]]
            assert set(ex["needs"]) <= owned, f"{ex['id']} needs {ex['needs']}, owned {owned}"
            assert not set(ex["avoid"]) & set(lim), f"{ex['id']} conflicts with {lim}"
            assert 1 <= i["sets"] <= 10 and 1 <= i["rep_min"] <= i["rep_max"]
            checked += 1
    if not owned & {"pull_up_bar", "bands", "cable"}:
        assert any("vertical pull" in w for w in plan["warnings"]), "missing v_pull gap warning"
    for w in plan["warnings"]:  # a gap warning must mean the pattern truly has no option
        for pattern, label in engine.PATTERN_NAMES.items():
            if w.startswith(f"No {label} exercise"):
                assert not engine.candidates(pattern, owned, profile), f"false warning: {w}"

# Prescription: 12 kg × 10 @ RIR 2 → e1RM 16.8 → 12 kg predicts 12 to failure, 14 kg only 6.
dbs = [{"type": "dumbbells", "weights_kg": list(range(2, 21, 2))}]
item = {"exercise_id": "db_curl", "sets": 3, "rep_min": 8, "rep_max": 12, "unit": "reps", "rest_seconds": 75}
rx = engine.prescribe(item, dbs, [{"session_id": 1, "load_kg": 12, "reps": 10, "rir": 2}])
assert (rx["load_kg"], rx["reps"]) == (12, 10), rx
assert {"load_kg": 14, "reps": 6} in rx["table"], rx["table"]

rx = engine.prescribe(item, dbs, [])  # no history → calibration, never an invented load
assert rx["load_kg"] is None and "Calibration" in rx["note"]

rx = engine.prescribe(item, [{"type": "dumbbells", "weights_kg": [2, 4]}], [{"session_id": 1, "load_kg": 4, "reps": 25, "rir": 0}])
assert rx["load_kg"] == 4 and "heaviest" in rx["note"], rx  # maxed-out equipment is flagged

rx = engine.prescribe(item, [{"type": "dumbbells", "weights_kg": [20]}], [{"session_id": 1, "load_kg": 10, "reps": 8, "rir": 1}])
assert rx["load_kg"] == 20 and rx["reps"] == 1 and "lightest" in rx["note"], rx

bw = {"exercise_id": "pushup", "sets": 3, "rep_min": 8, "rep_max": 12, "unit": "reps", "rest_seconds": 90}
rx = engine.prescribe(bw, [], [{"session_id": 2, "load_kg": 0, "reps": 12, "rir": None}] * 3)
assert rx["load_kg"] is None and "harder variation" in rx["note"]

print(f"engine ok — {checked} plan items checked")

r = engine.readiness
assert r(8, 1, 5, 1)["score"] == 100 and r(4, 5, 1, 5)["score"] == 0, "the ends of the scale"
assert r(10, 1, 5, 1) == r(8, 1, 5, 1), "sleep past 8 h adds nothing"
for args, k in itertools.product([(7, 2, 4, 2), (5, 4, 2, 4)], range(4)):
    worse = list(args)
    worse[k] = max(4, worse[k] - 1) if k == 0 else (min(5, worse[k] + 1) if k != 2 else max(1, worse[k] - 1))
    assert r(*worse)["score"] <= r(*args)["score"], f"feeling worse never raises readiness: {args} → {worse}"
assert r(8, 1, 5, 1)["advice"].startswith("Ready") and r(4, 5, 1, 5)["advice"].startswith("Go light")
print("readiness ok")
