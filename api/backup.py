"""SQLite backups: consistent online snapshots, each one proven restorable before it counts.

    python backup.py                 snapshot now (the API also does this once a day)
    python backup.py restore FILE    verify FILE, set the current DB aside as *.before-restore, put FILE in place;
                                     restart the API afterwards
    python backup.py test            self-check: back up, restore, compare

Snapshots live in backups/ next to the DB, so they share its disk. Copy them off the machine
(or download /api/export) if you need to survive losing that disk.
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


def counts(path: Path) -> dict[str, int]:
    """Row count per table. Raises unless the file opens as SQLite and passes integrity_check."""
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as c:
        if c.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise sqlite3.DatabaseError(f"{path} failed integrity_check")
        tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        return {t: c.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0] for t in tables}  # noqa: S608 — names from the file's own schema


def backup(db: Path = DB, keep: int = KEEP) -> Path:
    out = db.parent / "backups"
    out.mkdir(exist_ok=True)
    dest = out / f"kratos-{datetime.now(timezone.utc):%Y%m%dT%H%M%S%fZ}.db"
    with closing(sqlite3.connect(db)) as src, closing(sqlite3.connect(dest)) as dst:
        src.backup(dst)  # consistent even while the API is writing
    try:
        counts(dest)
    except sqlite3.DatabaseError:
        dest.unlink()  # never let a bad snapshot push a good one out of the window
        raise
    for old in sorted(out.glob("kratos-*.db"))[:-keep]:
        old.unlink()
    return dest


def restore(file: Path, db: Path = DB) -> None:
    counts(file)  # refuse a broken file before touching anything
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
            c.executescript("CREATE TABLE t (x); INSERT INTO t VALUES (1), (2), (3);")
        snaps = [backup(db, keep=2) for _ in range(3)]
        assert [p.exists() for p in snaps] == [False, True, True], "keeps only the newest 2"
        with closing(sqlite3.connect(db)) as c, c:
            c.execute("DELETE FROM t")
        restore(snaps[-1], db)
        assert counts(db) == {"t": 3}, "restored rows come back"
        assert counts(db.with_name("kratos.db.before-restore")) == {"t": 0}, "the replaced DB is kept"
        junk = Path(d) / "junk.db"
        junk.write_bytes(b"not a database" * 100)
        try:
            restore(junk, db)
            raise AssertionError("restored a broken file")
        except sqlite3.DatabaseError:
            pass
        assert counts(db) == {"t": 3}, "a refused restore leaves the DB alone"
    print("backup ok: snapshot, prune, restore, and refusal of a broken file")


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
