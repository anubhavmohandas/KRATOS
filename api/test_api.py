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

    def call(path: str, cookie: str = "", password: str | None = None):
        form = None if password is None else urllib.parse.urlencode({"password": password}).encode()
        try:
            with opener.open(urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=form, headers={"Cookie": cookie})) as r:
                return r.status, r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.headers

    for path in ("/api/profile", "/api/docs", "/api/openapi.json", "/api/export"):
        assert call(path)[0] == 401, f"{path} is open without logging in"
    status, h = call("/train/library")
    assert (status, h["Location"]) == (303, "/login"), "pages redirect to the login form"
    assert call("/login")[0] == 200
    assert call("/manifest.webmanifest")[0] not in (303, 401), "the manifest stays public so the PWA installs"
    assert call("/healthz")[0] == 200, "the host's health probe needs no login"

    assert call("/login", password="wrong")[0] == 401
    status, h = call("/login", password=PW)
    assert status == 303 and "HttpOnly" in h["Set-Cookie"]
    cookie = h["Set-Cookie"].split(";")[0]
    assert call("/api/profile", cookie)[0] == 200
    assert call("/api/docs", cookie)[0] == 200

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
    status, body = api("POST", f"/plans/{plan['id']}/explain")
    assert status == 502 and "Everything else" in body["detail"], "AI down → a clear 502, not a 500"

    sid = api("POST", "/sessions", {"plan_id": plan["id"], "day_index": 0})[1]["id"]
    one = {"exercise_id": plan["days"][0]["items"][0]["exercise_id"], "set_number": 1, "load_kg": 10, "reps": 8, "rir": 2}
    first = api("POST", f"/sessions/{sid}/sets", one)[1]
    retry = api("POST", f"/sessions/{sid}/sets", {**one, "reps": 9})[1]  # same set resent after a lost response
    assert retry["id"] == first["id"], "a resent set is updated, not logged twice"
    second = api("POST", f"/sessions/{sid}/sets", {**one, "set_number": 2})[1]
    sets = api("GET", f"/sessions/{sid}")[1]["sets"]  # what a resumed workout loads
    assert [(s["set_number"], s["reps"]) for s in sets] == [(1, 9), (2, 8)], sets
    assert api("DELETE", f"/sessions/{sid}/sets/{second['id']}")[0] == 204
    assert api("POST", f"/sessions/{sid}/complete")[0] == 200
    assert api("POST", f"/sessions/{sid}/sets", {**one, "set_number": 3})[0] == 409, "a finished workout takes no new sets"
    progress = api("GET", "/progress")[1]
    assert progress["totals"]["sets"] == 1 and len(progress["sessions"]) == 1, progress

    form = (b'--b\r\nContent-Disposition: form-data; name="file"; filename="plan.pdf"\r\nContent-Type: application/pdf\r\n\r\n'
            b"%PDF-1.7 truncated garbage\r\n--b--\r\n")
    assert api("POST", "/imports/pdf", data=form, ctype="multipart/form-data; boundary=b")[0] == 422, "a corrupt PDF is a 422"

    assert len(api("GET", "/export")[1]["set_logs"]) == 1
    assert api("DELETE", "/data")[0] == 204
    assert api("GET", "/profile")[1] is None and api("GET", "/export")[1]["set_logs"] == [], "delete-all leaves nothing"

    exp = str(int(time.time()) - 1)
    for bad in (f"kratos_session={exp}.{main.sign(exp)}", "kratos_session=9999999999.forged", "kratos_session=²",
                cookie.replace(".", ".0", 1)):
        assert call("/api/profile", bad)[0] == 401, f"accepted {bad}"
    assert "Max-Age=0" in call("/logout", cookie)[1]["Set-Cookie"], "logout clears the cookie"

    for _ in range(9):  # 10 failures in a minute, counting the one above
        call("/login", password="wrong")
    assert call("/login", password=PW)[0] == 429, "login is throttled after 10 failures a minute"

    deadline = time.time() + 5
    while not list((tmp / "backups").glob("kratos-*.db")):
        assert time.time() < deadline, "no backup taken at startup"
        time.sleep(0.1)
    server.should_exit = True
    print("api ok: every route gated, login/logout, forged/expired cookies refused, throttle, startup backup, "
          "journey (plan, set retry/undo/resume, finish, progress, corrupt PDF, delete-all) with the AI down")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as d:
        run(Path(d))
