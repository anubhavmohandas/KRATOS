"""Access gate, the core user journey and startup backup, against a live server on a throwaway DB: python test_api.py"""
import json
import os
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PW = "correct horse battery"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def run(tmp: Path) -> None:
    # AI points at a closed port: the provider is down for this whole run, and nothing else may notice.
    os.environ.update(KRATOS_DB=str(tmp / "kratos.db"), KRATOS_PASSWORD=PW,
                      KRATOS_LLM_API_KEY="test", KRATOS_LLM_BASE_URL="http://127.0.0.1:9")
    import uvicorn
    import main

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(main.app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    while not server.started:
        time.sleep(0.05)
    opener = urllib.request.build_opener(NoRedirect)

    def call(path: str, cookie: str = "", password: str | None = None, headers: dict | None = None, data: bytes | None = None):
        form = data if password is None else urllib.parse.urlencode({"password": password}).encode()
        try:
            with opener.open(urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=form, headers={"Cookie": cookie, **(headers or {})})) as r:
                return r.status, r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.headers

    for path in ("/api/profile", "/api/docs", "/api/openapi.json", "/api/export"):
        assert call(path)[0] == 401, f"{path} is open without logging in"
    status, h = call("/train/library")
    assert (status, h["Location"]) == (303, "/login"), "pages redirect to the login form"
    assert call("/login")[0] == 200
    for public in ("/manifest.webmanifest", "/sw.js", "/icon-192.png", "/apple-touch-icon.png"):
        assert call(public)[0] not in (303, 401), f"{public} stays public so the PWA installs and updates"
    assert call("/healthz")[0] == 200, "the host's health probe needs no login"
    h = call("/login")[1]
    assert "frame-ancestors 'none'" in h["Content-Security-Policy"] and h["X-Frame-Options"] == "DENY", "security headers on pages"
    assert call("/api/profile")[1]["X-Content-Type-Options"] == "nosniff", "…and on refusals"
    assert call("/login", headers={"Host": "evil.example"})[0] == 400, "a foreign Host header is refused (DNS rebinding)"
    assert call("/healthz", headers={"Host": "10.0.0.7:8000"})[0] == 200, "the probe works from the host's internal address"
    assert call("/login", password="x" * 3000)[0] == 413, "an oversized login body is refused before parsing"

    assert call("/login", password="wrong")[0] == 401
    status, h = call("/login", password=PW)
    assert status == 303 and "HttpOnly" in h["Set-Cookie"]
    cookie = h["Set-Cookie"].split(";")[0]
    assert call("/api/profile", cookie)[0] == 200
    assert call("/api/docs", cookie)[0] == 200
    evil = {"Origin": "https://evil.example"}
    assert call("/api/plans/generate", cookie, headers=evil, data=b"")[0] == 403, "a cross-site write is refused"
    assert call("/api/plans/generate", cookie, headers={"Origin": f"http://127.0.0.1:{port}"}, data=b"")[0] == 409, "same-origin passes"

    def api(method: str, path: str, body=None, data: bytes | None = None, ctype: str = "application/json"):
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api{path}", method=method,
                                     data=json.dumps(body).encode() if body is not None else data,
                                     headers={"Cookie": cookie, "Content-Type": ctype})
        try:
            with opener.open(req) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"null")

    # Journey: profile → equipment → plan → workout (retry, undo, resume, finish) → progress → corrupt PDF → wipe.
    assert api("PUT", "/profile", {"age": 30, "height_cm": 178, "weight_kg": 80, "experience": "beginner", "goal": "strength",
                                   "days_per_week": 3, "session_minutes": 45})[0] == 200
    assert api("POST", "/equipment", {"type": "dumbbells", "weights_kg": [5, 10, 15]})[0] == 201
    status, plan = api("POST", "/plans/generate")
    assert status == 201 and plan["days"][0]["items"], plan
    item = {"exercise_id": "pushup", "sets": 3, "rep_min": 8, "rep_max": 12, "rest_seconds": 60}
    for name in ("Day\x00one", "   ", "x" * 41):
        assert api("POST", "/plans", {"days": [{"name": name, "items": [item]}]})[0] == 422, f"plan day name {name!r} accepted"
    assert api("POST", "/plans", {"days": [{"name": "  Day one ", "items": [item]}]})[1]["days"][0]["name"] == "Day one"
    assert api("POST", f"/plans/{plan['id']}/activate")[0] == 200
    status, body = api("POST", f"/plans/{plan['id']}/explain")
    assert status == 502 and "Everything else" in body["detail"], "AI down → a clear 502, not a 500"

    assert api("GET", "/sessions/open")[1] is None
    sid = api("POST", "/sessions", {"plan_id": plan["id"], "day_index": 0})[1]["id"]
    assert api("GET", "/sessions/open")[1] == {"id": sid, "plan_id": plan["id"], "day_index": 0}, "another device can resume it"
    one = {"exercise_id": plan["days"][0]["items"][0]["exercise_id"], "set_number": 1, "load_kg": 10, "reps": 8, "rir": 2}
    first = api("POST", f"/sessions/{sid}/sets", one)[1]
    retry = api("POST", f"/sessions/{sid}/sets", {**one, "reps": 9})[1]  # same set resent after a lost response
    assert retry["id"] == first["id"], "a resent set is updated, not logged twice"
    second = api("POST", f"/sessions/{sid}/sets", {**one, "set_number": 2})[1]
    sets = api("GET", f"/sessions/{sid}")[1]["sets"]  # what a resumed workout loads
    assert [(s["set_number"], s["reps"]) for s in sets] == [(1, 9), (2, 8)], sets
    assert api("DELETE", f"/sessions/{sid}/sets/{second['id']}")[0] == 204
    assert api("POST", f"/sessions/{sid}/complete")[0] == 200
    assert api("GET", "/sessions/open")[1] is None, "a finished workout isn't offered for resume"
    assert api("POST", f"/sessions/{sid}/sets", {**one, "set_number": 3})[0] == 409, "a finished workout takes no new sets"
    progress = api("GET", "/progress")[1]
    assert progress["totals"]["sets"] == 1 and len(progress["sessions"]) == 1, progress
    assert progress["sessions"][0]["day"] == plan["days"][0]["name"] and progress["sessions"][0]["sets"] == 1, "calendar needs day and sets"

    # Recovery, nutrition, calendar settings.
    status, ci = api("PUT", "/checkins/2026-10-11", {"sleep_h": 8, "soreness": 1, "energy": 5, "stress": 1, "note": "slept well"})
    assert status == 200 and ci["score"] == 100 and ci["advice"].startswith("Ready"), ci
    assert api("PUT", "/checkins/2026-10-11", {"sleep_h": 4, "soreness": 5, "energy": 1, "stress": 5})[1]["score"] == 0, "answering again replaces it"
    assert [c["day"] for c in api("GET", "/checkins?since=2026-10-01")[1]] == ["2026-10-11"]
    for bad_day in ("2026-13-01", "2026-10-1", "today"):
        assert api("PUT", f"/checkins/{bad_day}", {"sleep_h": 7, "soreness": 2, "energy": 3, "stress": 2})[0] == 422, bad_day
    assert api("PUT", "/checkins/2026-10-12", {"sleep_h": 7, "soreness": 9, "energy": 3, "stress": 2})[0] == 422, "scales are 1–5"
    assert api("PUT", "/checkins/2026-10-12", {"sleep_h": 7, "soreness": 2, "energy": 3, "stress": 2, "note": "a\x1bb"})[0] == 422
    status, meal = api("POST", "/meals", {"day": "2026-10-11", "name": "Oats & whey", "kcal": 450, "protein_g": 32})
    assert status == 201 and meal["id"]
    assert api("POST", "/meals", {"day": "2026-10-11", "name": "Water"})[0] == 422, "a meal needs calories or protein"
    assert api("POST", "/meals", {"day": "2026-10-11", "name": "<script>", "kcal": 1})[1]["name"] == "<script>", "stored as text; React escapes it"
    assert len(api("GET", "/meals?since=2026-10-11")[1]) == 2 and api("GET", "/meals?since=2026-10-12")[1] == []
    assert api("DELETE", f"/meals/{meal['id']}")[0] == 204 and len(api("GET", "/meals?since=2026-10-01")[1]) == 1
    prof = {"age": 30, "height_cm": 178, "weight_kg": 80, "experience": "beginner", "goal": "strength", "days_per_week": 3, "session_minutes": 45}
    assert api("PUT", "/profile", {**prof, "weekdays": [4, 0, 0], "train_time": "18:30"})[1]["weekdays"] == [0, 4]
    for bad in ({"train_time": "25:00"}, {"weekdays": [7]}, {"kcal_target": 100}):
        assert api("PUT", "/profile", {**prof, **bad})[0] == 422, bad

    def upload(path: str, filename: str, data: bytes):
        body = (b'--b\r\nContent-Disposition: form-data; name="file"; filename="' + filename.encode() + b'"\r\n'
                b"Content-Type: application/octet-stream\r\n\r\n" + data + b"\r\n--b--\r\n")
        return api("POST", path, data=body, ctype="multipart/form-data; boundary=b")

    assert upload("/imports/pdf", "plan.pdf", b"%PDF-1.7 truncated garbage")[0] == 422, "a corrupt PDF is a 422"

    assert len(api("GET", "/export")[1]["set_logs"]) == 1
    assert api("DELETE", "/data")[0] == 204
    wiped = api("GET", "/export")[1]
    assert api("GET", "/profile")[1] is None and not any(wiped.values()), f"delete-all leaves nothing: {wiped}"

    # Backups: the snapshot taken before delete-all, a downloaded copy, and refusals.
    newest = api("GET", "/backups")[1][0]["name"]
    status, rows = api("POST", f"/backups/{newest}/restore")
    assert status == 200 and rows["set_logs"] == 1 and api("GET", "/profile")[1], "delete-all is undone from its snapshot"
    with opener.open(urllib.request.Request(f"http://127.0.0.1:{port}/api/backup", headers={"Cookie": cookie})) as r:
        copy = r.read()
    assert copy.startswith(b"SQLite format 3\x00") and "attachment" in r.headers["Content-Disposition"]
    assert api("DELETE", "/data")[0] == 204
    status, rows = upload("/restore", "kratos.db", copy)
    assert status == 200 and rows["set_logs"] == 1, "a downloaded backup restores"
    assert upload("/restore", "x.db", b"SQLite format 3\x00" + b"junk" * 100)[0] == 422, "a broken backup is refused"
    assert api("GET", "/export")[1]["set_logs"], "…and leaves the data alone"
    assert api("POST", "/backups/kratos.db/restore")[0] == 404, "only snapshot names restore"

    exp = str(int(time.time()) - 1)
    for bad in (f"kratos_session={exp}.{main.sign(exp)}", "kratos_session=9999999999.forged", "kratos_session=²",
                cookie.replace(".", ".0", 1)):
        assert call("/api/profile", bad)[0] == 401, f"accepted {bad}"
    assert "Max-Age=0" in call("/logout", cookie)[1]["Set-Cookie"], "logout clears the cookie"

    for _ in range(9):  # 10 failures in a minute, counting the one above
        call("/login", password="wrong")
    assert call("/login", password=PW)[0] == 429, "login is throttled after 10 failures a minute"
    status, h = call("/login", password=PW, headers={"X-Forwarded-For": "203.0.113.9"})
    assert status == 303, "another address isn't locked out by someone else's failures"
    phone = h["Set-Cookie"].split(";")[0]
    assert call("/api/profile", phone)[0] == 200
    assert call("/api/logout-everywhere", cookie, data=b"")[0] == 204
    assert call("/api/profile", phone)[0] == 401 and call("/api/profile", cookie)[0] == 401, "log out everywhere ends every session"

    deadline = time.time() + 5
    while not list((tmp / "backups").glob("kratos-*.db")):
        assert time.time() < deadline, "no backup taken at startup"
        time.sleep(0.1)
    server.should_exit = True
    print("api ok: every route gated, security headers, host/origin/body-size checks, login/logout/log-out-everywhere, forged/expired cookies refused, per-address throttle, startup backup, "
          "journey (plan, set retry/undo/resume on any device, finish, progress, check-ins, meals, calendar days, corrupt PDF, delete-all, restore from snapshot/download) with the AI down")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as d:
        run(Path(d))
