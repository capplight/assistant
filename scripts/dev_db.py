"""Local Postgres 17 + pgvector (+ pg_trgm, optional PostGIS) for development on Windows.

No Docker and no admin rights: official EnterpriseDB zip binaries, the prebuilt pgvector DLL
(andreiramani/pgvector_pgsql_windows) and, with --postgis, the OSGeo PostGIS bundle are
unpacked into `.devdb/` (gitignored). Every download is pinned by SHA-256.

    python scripts/dev_db.py start [--postgis]   # install if needed, initdb, start, create db
    python scripts/dev_db.py url                 # print DATABASE_URL
    python scripts/dev_db.py status
    python scripts/dev_db.py stop
    python scripts/dev_db.py reset               # stop and delete the data directory

Port: DEV_DB_PORT (default 54329). Auth is `trust` on localhost only. Stdlib only, so any
Python 3.12+ runs it. On Linux/macOS use `docker compose up -d db` instead.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent.parent / ".devdb"
DOWNLOADS = ROOT / "downloads"
PGHOME = ROOT / "pgsql"
DATA = ROOT / "data"
LOG = ROOT / "postgres.log"
BIN = PGHOME / "bin"

PORT = int(os.environ.get("DEV_DB_PORT", "54329"))
USER = DB = "assistant"
# English tool and server messages (the Windows default is the system language in cp1251).
ENV = {**os.environ, "LC_MESSAGES": "C", "LANG": "C"}

# (file name, url, sha256)
POSTGRES = (
    "postgresql-17.11-1-windows-x64-binaries.zip",
    "https://get.enterprisedb.com/postgresql/postgresql-17.11-1-windows-x64-binaries.zip",
    "6eabdf00d2893713b75db4336a23c3fdf505f056e217ec6e2e95d901750cfea3",
)
PGVECTOR = (
    "vector.v0.8.6-pg17.zip",
    "https://github.com/andreiramani/pgvector_pgsql_windows/releases/download/0.8.6_17/"
    "vector.v0.8.6-pg17.zip",
    "420388e9e9f05d92f06d6967ce8772483629b27a66ca9255925fa0fdd445438e",
)
POSTGIS = (
    "postgis-bundle-pg17-3.6.2x64.zip",
    "https://download.osgeo.org/postgis/windows/pg17/postgis-bundle-pg17-3.6.2x64.zip",
    "7ba180ee2a352987b9a2f194673652c59483b55852295ccf401dceccd8765425",
)
# Parts of the EDB archive we don't need (GUI tools, debug symbols, docs).
SKIP_TOP = {"pgAdmin 4", "StackBuilder", "symbols", "doc"}
OVERLAY_DIRS = {"bin", "lib", "share"}


def url() -> str:
    return f"postgresql+asyncpg://{USER}:{USER}@localhost:{PORT}/{DB}"


def _fetch(spec: tuple[str, str, str]) -> Path:
    name, src, sha = spec
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    path = DOWNLOADS / name
    if not path.exists():
        print(f"downloading {src}", flush=True)
        tmp = path.with_suffix(".part")
        with urllib.request.urlopen(src) as resp, tmp.open("wb") as out:
            shutil.copyfileobj(resp, out, 1 << 20)
        tmp.replace(path)
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    if digest.hexdigest() != sha:
        path.unlink()
        sys.exit(f"checksum mismatch for {name}; deleted, rerun to download again")
    return path


def _extract(archive: Path, dest: Path, rel_of) -> None:
    """Unpack members whose `rel_of(parts)` is not None to dest/rel, refusing path escapes."""
    base = dest.resolve()
    with zipfile.ZipFile(archive) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            rel = rel_of(PurePosixPath(info.filename).parts)
            if not rel:
                continue
            target = (base / Path(*rel)).resolve()
            if not target.is_relative_to(base) or ".." in rel:
                sys.exit(f"refusing suspicious path {info.filename!r} in {archive.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, target.open("wb") as out:
                shutil.copyfileobj(src, out)


def _overlay(parts: tuple[str, ...]) -> tuple[str, ...] | None:
    # Accept "lib/x.dll" or "bundle-dir/lib/x.dll"; keep only bin/lib/share.
    for i, p in enumerate(parts[:2]):
        if p in OVERLAY_DIRS:
            return parts[i:]
    return None


def install(postgis: bool) -> None:
    if not (BIN / "postgres.exe").exists():
        archive = _fetch(POSTGRES)
        print("unpacking PostgreSQL", flush=True)
        tmp = ROOT / "pgsql.part"
        shutil.rmtree(tmp, ignore_errors=True)
        _extract(archive, tmp, lambda p: p[1:] if p[0] == "pgsql" and p[1] not in SKIP_TOP
                 else None)
        tmp.replace(PGHOME)
    if not (PGHOME / "lib" / "vector.dll").exists():
        _extract(_fetch(PGVECTOR), PGHOME, _overlay)
        print("pgvector installed", flush=True)
    if postgis and not (PGHOME / "share" / "extension" / "postgis.control").exists():
        print("unpacking PostGIS", flush=True)
        _extract(_fetch(POSTGIS), PGHOME, _overlay)
        print("PostGIS installed", flush=True)


def _run(*args: str | Path, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    # stdout/stderr to files or DEVNULL, never pipes: postgres inherits pg_ctl's handles on
    # Windows and an open pipe would make this call hang until the server exits.
    return subprocess.run([str(a) for a in args], check=check, stdin=subprocess.DEVNULL, env=ENV)


def _psql(sql: str) -> str:
    out = subprocess.run(
        [str(BIN / "psql"), "-h", "localhost", "-p", str(PORT), "-U", USER, "-d", "postgres",
         "-tAc", sql],
        check=True, capture_output=True, text=True, stdin=subprocess.DEVNULL, env=ENV,
    )
    return out.stdout.strip()


def running() -> bool:
    if not (DATA / "PG_VERSION").exists():
        return False
    res = subprocess.run([str(BIN / "pg_ctl"), "status", "-D", str(DATA)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, env=ENV)
    return res.returncode == 0


def start(postgis: bool) -> None:
    install(postgis)
    if not (DATA / "PG_VERSION").exists():
        # Builtin C.UTF-8 provider: Unicode-aware lower()/ILIKE for Cyrillic, independent of
        # the Windows system locale.
        _run(BIN / "initdb", "-D", DATA, "-U", USER, "-A", "trust", "-E", "UTF8",
             "--locale=C", "--locale-provider=builtin", "--builtin-locale=C.UTF-8",
             "--no-instructions")
    if not running():
        res = subprocess.run(
            [str(BIN / "pg_ctl"), "start", "-w", "-D", str(DATA), "-l", str(LOG),
             "-o", f"-p {PORT} -c listen_addresses=localhost"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env=ENV,
        )
        if res.returncode != 0:
            tail = LOG.read_text(errors="replace")[-2000:] if LOG.exists() else ""
            sys.exit(f"postgres failed to start; log tail:\n{tail}")
    if _psql(f"SELECT 1 FROM pg_database WHERE datname = '{DB}'") != "1":
        _psql(f"CREATE DATABASE {DB}")
    print(f"running on port {PORT}\nDATABASE_URL={url()}")


def stop() -> None:
    if running():
        _run(BIN / "pg_ctl", "stop", "-w", "-m", "fast", "-D", DATA)
    print("stopped")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name in ("install", "start"):
        p = sub.add_parser(name)
        p.add_argument("--postgis", action="store_true", help="also install PostGIS (~120 MB)")
    for name in ("stop", "url", "status", "reset"):
        sub.add_parser(name)
    args = parser.parse_args()

    if args.cmd == "url":
        print(url())
        return
    if sys.platform != "win32":
        sys.exit("this script is for Windows; elsewhere run `docker compose up -d db`")
    if args.cmd == "install":
        install(args.postgis)
    elif args.cmd == "start":
        start(args.postgis)
    elif args.cmd == "stop":
        stop()
    elif args.cmd == "status":
        print(f"running on port {PORT}" if running() else "not running")
    elif args.cmd == "reset":
        stop()
        shutil.rmtree(DATA, ignore_errors=True)
        print("data directory removed")


if __name__ == "__main__":
    main()
