"""Access gate + startup backup, checked against a live server on a throwaway DB: python test_api.py"""
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
    os.environ.update(KRATOS_DB=str(tmp / "kratos.db"), KRATOS_PASSWORD=PW)
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

    assert call("/login", password="wrong")[0] == 401
    status, h = call("/login", password=PW)
    assert status == 303 and "HttpOnly" in h["Set-Cookie"]
    cookie = h["Set-Cookie"].split(";")[0]
    assert call("/api/profile", cookie)[0] == 200
    assert call("/api/docs", cookie)[0] == 200

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
    print("api ok: every route gated, login/logout, forged/expired cookies refused, throttle, startup backup")


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as d:
        run(Path(d))
