"""Workout PDF → reviewable plan draft. Rule-based first; the LLM path only supplies names/numbers we re-validate."""
import difflib
import io
import re

from pypdf import PdfReader

from engine import CATALOG

MAX_PAGES = 40
MAX_CHARS = 60_000

_RANGE = r"(?P<lo>\d{1,3})(?:\s*(?:-|–|to)\s*(?P<hi>\d{1,3}))?"
SETS_REPS = [
    re.compile(r"(?P<sets>\d{1,2})\s*(?:sets?\s*)?[x×*]\s*" + _RANGE, re.I),            # 3x8-12, 3 x 10, 4 sets x 6
    re.compile(r"(?P<sets>\d{1,2})\s*sets?\s*(?:of\s*)?" + _RANGE, re.I),               # 3 sets of 10, 3 sets 8-12
    re.compile(r"\s(?P<sets>\d{1,2})\s+" + _RANGE + r"(?=\s|$)"),                        # table row: name  3  8-12
]
SECONDS = re.compile(r"^\s*(s|sec|secs|seconds)\b", re.I)
REST = re.compile(r"(?:rest\s*[:\-]?\s*(?P<a>\d{1,3})\s*(?P<au>min|mins|minutes|m)?|(?P<b>\d{1,3})\s*(?P<bu>min|mins|minutes|m|s|sec|secs|seconds)?\s*rest)", re.I)
DAY = re.compile(
    r"^\s*(day\s*\d+|week\s*\d+\W*day\s*\d+|(mon|tues|wednes|thurs|fri|satur|sun)day|"
    r"(push|pull|legs?|upper|lower|full\s*body|chest|back|shoulders?|arms?)(\s*(day|workout|session|[a-c]))?)\b[^\d]*$",
    re.I,
)
BULLET = re.compile(r"^\s*(?:[-•*·▪]|\(?[a-z]?\d{1,2}[.):]|[a-z][.)])\s*", re.I)


def norm(s: str) -> str:
    s = s.lower().replace("dumbbell", "db").replace("barbell", "bb").replace("kettlebell", "kb").replace("-", " ")
    s = re.sub(r"[^a-z0-9 ]", "", s)
    return " ".join(re.sub(r"s\b", "", w) for w in s.split())  # crude singular: squats→squat, press→pres on both sides


NAMES = {norm(n): e["id"] for e in CATALOG for n in [e["name"], *e.get("aliases", [])]}


def match_exercise(name: str) -> tuple[str | None, float]:
    n = norm(name)
    if n in NAMES:
        return NAMES[n], 1.0
    best = difflib.get_close_matches(n, NAMES.keys(), n=1, cutoff=0.6)
    if not best:
        return None, 0.0
    return NAMES[best[0]], round(difflib.SequenceMatcher(None, n, best[0]).ratio(), 2)


def extract_text(data: bytes) -> str:
    # occam: parsed in-process with size/page caps; run in a subprocess with a timeout if PDFs ever come from other people.
    if not data.startswith(b"%PDF-"):
        raise ValueError("That file isn't a PDF.")
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        raise ValueError("Password-protected PDFs aren't supported.")
    if len(reader.pages) > MAX_PAGES:
        raise ValueError(f"PDF has {len(reader.pages)} pages; the limit is {MAX_PAGES}.")
    return "\n".join(p.extract_text() or "" for p in reader.pages)[:MAX_CHARS]


def _rest(text: str) -> int | None:
    m = REST.search(text)
    if not m:
        return None
    n, unit = (m["a"], m["au"]) if m["a"] else (m["b"], m["bu"])
    secs = int(n) * 60 if unit and unit.lower().startswith("m") else int(n)
    return secs if 0 <= secs <= 600 else None


def _row(name: str, sets: int, lo: int, hi: int, unit: str, rest: int | None, raw: str) -> dict:
    ex_id, conf = match_exercise(name)
    return {"raw": raw, "name": name, "exercise_id": ex_id, "confidence": conf, "sets": sets,
            "rep_min": lo, "rep_max": hi, "unit": unit, "rest_seconds": rest or 90}


def parse_text(text: str) -> list[dict]:
    days: list[dict] = []
    cur, pending = None, ""
    for raw in text.splitlines():
        line = " ".join(raw.split())
        if not line or len(line) > 160:
            continue
        m = next((m for p in SETS_REPS if (m := p.search(line))), None)
        if not m:
            if DAY.match(line):
                cur = {"name": line[:40], "items": []}
                days.append(cur)
            else:
                pending = line  # an exercise name whose numbers may sit on the next line (table cells)
            continue
        name = BULLET.sub("", line[: m.start()]).strip(" :–-|,")
        if len(name) < 3:
            name = BULLET.sub("", pending).strip(" :–-|,")
        pending = ""
        sets, lo = int(m["sets"]), int(m["lo"])
        hi = int(m["hi"] or lo)
        if len(name) < 3 or not (1 <= sets <= 10 and 1 <= lo <= hi <= 300):
            continue
        tail = line[m.end():]
        unit = "sec" if SECONDS.match(tail) else "reps"
        if cur is None:
            cur = {"name": "Day 1", "items": []}
            days.append(cur)
        cur["items"].append(_row(name[:80], sets, lo, hi, unit, _rest(tail), line))
    return [d for d in days if d["items"]][:7]


def from_ai(days: list) -> list[dict]:
    """Re-match AI-extracted names against the catalog; the model never chooses exercise ids."""
    out = []
    for d in days[:7]:
        items = [_row(i.name, i.sets, i.rep_min, i.rep_max, i.unit, i.rest_seconds, i.name) for i in d.items[:15]]
        if items:
            out.append({"name": d.name[:40], "items": items})
    return out


if __name__ == "__main__":
    sample = """WEEK 1
Day 1 - Push
1. Bench Press 4 x 6-8 rest 2 min
2. DB Shoulder Press 3x10 90s rest
- Diamond push ups 3 sets of 12
Day 2 - Pull
A1) Pull Ups 4x5
Bent over rows 3 x 8-10
Plank 3x45s
Skull crushers 3x12"""
    days = parse_text(sample)
    assert [d["name"] for d in days] == ["Day 1 - Push", "Day 2 - Pull"], days
    push, pull = days[0]["items"], days[1]["items"]
    assert [i["exercise_id"] for i in push] == ["bb_bench_press", "db_shoulder_press", "close_grip_pushup"], push
    assert (push[0]["sets"], push[0]["rep_min"], push[0]["rep_max"], push[0]["rest_seconds"]) == (4, 6, 8, 120)
    assert push[1]["rest_seconds"] == 90
    assert [i["exercise_id"] for i in pull[:3]] == ["pullup", "bb_row", "plank"], pull
    assert pull[2]["unit"] == "sec" and pull[2]["rep_min"] == 45
    assert pull[3]["exercise_id"] is None  # not in the catalog → user resolves it in review
    print("pdf_import ok")
