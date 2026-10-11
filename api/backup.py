"""SQLite backups: consistent online snapshots, each one proven restorable before it counts.

    python backup.py                 snapshot now (the API also does this once a day)
    python backup.py restore FILE    verify FILE, set the current DB aside as *.before-restore, put FILE in place;
                                     restart the API afterwards (or restore from Settings in the app, no restart)
    python backup.py test            self-check: back up, restore, compare

Snapshots live in backups/ next to the DB, so they share its disk. Copy them off the machine
(download /api/backup, see the README) if you need to survive losing that disk.
"""
import os
import sqlite3
import sys
import tempfile
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

DB = Path(os.getenv("KRATOS_DB", Path(__file__).parent / "kratos.db"))
KEEP = 14
CORE = {"profile", "equipment", "assessments", "plans", "sessions", "set_logs"}


def counts(path: Path) -> dict[str, int]:
    """Row count per table. Raises unless the file opens as SQLite and passes integrity_check."""
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as c:
        if c.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise sqlite3.DatabaseError(f"{path} failed integrity_check")
        tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        # Quote the file's own table names safely: a restore may hand us a crafted file.
        return {t: c.execute('SELECT COUNT(*) FROM "%s"' % t.replace('"', '""')).fetchone()[0] for t in tables}  # noqa: S608


def check(path: Path) -> dict[str, int]:
    """A KRATOS database: intact, has the core tables, and holds no triggers or views (code that would run in the app)."""
    n = counts(path)
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as c:
        kinds = {t for (t,) in c.execute("SELECT DISTINCT type FROM sqlite_master")}
    if kinds - {"table", "index"} or not CORE <= n.keys():
        raise sqlite3.DatabaseError("That file isn't a KRATOS backup.")
    return n


def snapshot(dest: Path, db: Path = DB) -> Path:
    """Consistent copy of db at dest, even while the API is writing; deleted again unless it verifies."""
    with closing(sqlite3.connect(db)) as src, closing(sqlite3.connect(dest)) as dst:
        src.backup(dst)
    try:
        counts(dest)
    except sqlite3.DatabaseError:
        dest.unlink()  # never let a bad snapshot push a good one out of the window
        raise
    return dest


def backup(db: Path = DB, keep: int = KEEP) -> Path:
    out = db.parent / "backups"
    out.mkdir(exist_ok=True)
    dest = snapshot(out / f"kratos-{datetime.now(timezone.utc):%Y%m%dT%H%M%S%fZ}.db", db)
    for old in sorted(out.glob("kratos-*.db"))[:-keep]:
        old.unlink()
    return dest


def restore(file: Path, db: Path = DB) -> None:
    check(file)  # refuse a broken or foreign file before touching anything
    tmp = db.with_name(db.name + ".restoring")
    tmp.write_bytes(file.read_bytes())
    if db.exists():
        os.replace(db, db.with_name(db.name + ".before-restore"))
    for side in ("-journal", "-wal", "-shm"):  # a leftover journal would be replayed onto the restored file
        db.with_name(db.name + side).unlink(missing_ok=True)
    os.replace(tmp, db)


def run_daily() -> None:
    """Back up when the newest snapshot is over a day old. Hourly checks survive restarts and sleeping hosts."""
    while True:
        newest = max((p.stat().st_mtime for p in (DB.parent / "backups").glob("kratos-*.db")), default=0)
        if time.time() - newest > 86400:
            try:
                backup()
            except Exception as e:  # a failed backup must not take the API down; it retries next hour
                print(f"KRATOS backup failed: {e}", file=sys.stderr, flush=True)
        time.sleep(3600)


def _test() -> None:
    with tempfile.TemporaryDirectory() as d:
        db = Path(d) / "kratos.db"
        with closing(sqlite3.connect(db)) as c, c:
            c.executescript("".join(f"CREATE TABLE {t} (x);" for t in sorted(CORE)) + "INSERT INTO set_logs VALUES (1), (2), (3);")
        snaps = [backup(db, keep=2) for _ in range(3)]
        assert [p.exists() for p in snaps] == [False, True, True], "keeps only the newest 2"
        with closing(sqlite3.connect(db)) as c, c:
            c.execute("DELETE FROM set_logs")
        restore(snaps[-1], db)
        assert counts(db)["set_logs"] == 3, "restored rows come back"
        assert counts(db.with_name("kratos.db.before-restore"))["set_logs"] == 0, "the replaced DB is kept"
        bad = {"junk": lambda p: p.write_bytes(b"not a database" * 100),
               "foreign": lambda p: _make(p, 'CREATE TABLE "a""b" (x);'),
               "trigger": lambda p: _make(p, "".join(f"CREATE TABLE {t} (x);" for t in CORE)
                                          + "CREATE TRIGGER t AFTER INSERT ON set_logs BEGIN DELETE FROM profile; END;")}
        for name, make in bad.items():
            make(Path(d) / f"{name}.db")
            try:
                restore(Path(d) / f"{name}.db", db)
                raise AssertionError(f"restored a {name} file")
            except sqlite3.DatabaseError:
                pass
        assert counts(db)["set_logs"] == 3, "a refused restore leaves the DB alone"
    print("backup ok: snapshot, prune, restore, and refusal of broken, foreign and trigger-carrying files")


def _make(path: Path, sql: str) -> None:
    with closing(sqlite3.connect(path)) as c, c:
        c.executescript(sql)


if __name__ == "__main__":
    if sys.argv[1:2] == ["test"]:
        _test()
    elif sys.argv[1:2] == ["restore"] and len(sys.argv) == 3:
        restore(Path(sys.argv[2]))
        print(f"restored {sys.argv[2]} → {DB} (previous DB kept as {DB.name}.before-restore). Restart the API.")
    elif len(sys.argv) == 1:
        print(backup())
    else:
        sys.exit(__doc__)
