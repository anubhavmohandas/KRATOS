"""Workout PDF → reviewable plan draft. Rule-based first; the LLM path only supplies names/numbers we re-validate."""
import difflib
import io
import json
import re
import shutil
import subprocess
import sys

from pypdf import PdfReader

from engine import CATALOG

MAX_PAGES = 40
MAX_CHARS = 60_000
OCR_PAGES = 10
OCR_DPI = 200
OCR_MAX_PX = 4000  # longest side of a rendered page: a giant page box can't make a giant bitmap
READ_SECONDS = 180

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


def read(data: bytes) -> tuple[str, bool]:
    """Text of a PDF and whether OCR produced it. PDFs come from other people, so parsing runs in a child process with a
    time limit (and a memory cap on Linux): a hostile or broken file can stall or crash the child, never the API."""
    if not data.startswith(b"%PDF-"):
        raise ValueError("That file isn't a PDF.")
    try:
        r = subprocess.run([sys.executable, __file__, "--read"], input=data, capture_output=True, timeout=READ_SECONDS)
    except subprocess.TimeoutExpired:
        raise ValueError("That PDF took too long to read.") from None
    try:
        out = json.loads(r.stdout)
    except ValueError:
        raise ValueError("Couldn't read that PDF.") from None
    if "error" in out:
        raise ValueError(out["error"])
    return out["text"], out["ocr"]


def _read_child() -> None:
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (2 * 2**30, 2 * 2**30))
    except (ImportError, ValueError, OSError):
        pass  # macOS ignores address-space limits; the timeout still applies
    data = sys.stdin.buffer.read()
    try:
        text = extract_text(data)
        ocr_used = not text.strip()
        out = {"text": ocr(data) if ocr_used else text, "ocr": ocr_used}
    except ValueError as e:
        out = {"error": str(e)}
    except Exception:  # pypdf and pdfium raise a zoo of errors on malformed files
        out = {"error": "Couldn't read that PDF."}
    sys.stdout.write(json.dumps(out))


def ocr(data: bytes) -> str:
    """Scanned pages: each rendered in grey at 200 dpi and read by Tesseract."""
    if not shutil.which("tesseract"):
        raise ValueError("No text found — this looks like a scanned PDF, and OCR (tesseract) isn't installed on the server.")
    import pypdfium2 as pdfium  # only scanned PDFs need it

    pdf = pdfium.PdfDocument(data)
    pages = []
    for i in range(min(len(pdf), OCR_PAGES)):
        page = pdf[i]
        scale = min(OCR_DPI / 72, OCR_MAX_PX / max(page.get_size()))
        bmp = page.render(scale=scale, grayscale=True)
        buf, w, h, stride = bytes(bmp.buffer), bmp.width, bmp.height, bmp.stride
        pgm = b"P5 %d %d 255\n" % (w, h) + b"".join(buf[y * stride:y * stride + w] for y in range(h))
        r = subprocess.run(["tesseract", "stdin", "stdout"], input=pgm, capture_output=True, timeout=60)
        pages.append(r.stdout.decode("utf-8", "replace"))
    return "\n".join(pages)[:MAX_CHARS]


def extract_text(data: bytes) -> str:
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


def _pdf(lines: list[str]) -> bytes:
    """A one-page Helvetica text PDF, for the self-check."""
    text = "\n".join(f"BT /F1 14 Tf 50 {750 - i * 22} Td ({line}) Tj ET" for i, line in enumerate(lines))
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            f"<< /Length {len(text)} >>\nstream\n{text}\nendstream", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, at = "%PDF-1.4\n", []
    for i, o in enumerate(objs):
        at.append(len(out))
        out += f"{i + 1} 0 obj\n{o}\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n" + "".join(f"{p:010d} 00000 n \n" for p in at)
    return (out + f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").encode("latin-1")


def _scanned(text_pdf: bytes) -> bytes:
    """The same page as a picture with no text layer, like a phone scan."""
    import pypdfium2 as pdfium

    src = pdfium.PdfDocument(text_pdf)
    bmp = src[0].render(scale=2)
    out = pdfium.PdfDocument.new()
    w, h = src[0].get_size()
    page = out.new_page(w, h)
    img = pdfium.PdfImage.new(out)
    img.set_bitmap(bmp)
    img.set_matrix(pdfium.PdfMatrix().scale(w, h))
    page.insert_obj(img)
    page.gen_content()
    buf = io.BytesIO()
    out.save(buf)
    return buf.getvalue()


if __name__ == "__main__" and sys.argv[1:] == ["--read"]:
    _read_child()
elif __name__ == "__main__":
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

    lines = ["Day 1 - Push", "Push-ups 3 x 10", "Goblet squat 3 x 12 rest 90s"]
    text, used = read(_pdf(lines))
    assert not used and "Goblet squat" in text, text
    for bad in (b"%PDF-1.7 truncated garbage", b"%PDF-" + b"\x00" * 5000):
        try:
            read(bad)
            raise AssertionError("read a broken PDF")
        except ValueError as e:
            assert "PDF" in str(e), e
    if shutil.which("tesseract"):
        text, used = read(_scanned(_pdf(lines)))
        assert used, "a picture-only PDF goes through OCR"
        assert [i["exercise_id"] for d in parse_text(text) for i in d["items"]] == ["pushup", "goblet_squat"], text
        print("pdf_import ok (text, broken files, scanned via OCR)")
    else:
        print("pdf_import ok (text, broken files); OCR skipped: tesseract isn't installed")
