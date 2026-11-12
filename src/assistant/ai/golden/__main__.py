"""python -m assistant.ai.golden [--data DIR] [--kind K ...] [--live] [--json FILE]

Exit code 0 when every admission threshold holds, 1 otherwise. Output: metrics only."""

import argparse
import asyncio
from pathlib import Path

from assistant.ai.golden import render, run_golden, to_json
from assistant.logs import configure_logging


def main(argv: list[str] | None = None) -> int:
    configure_logging("ERROR")
    p = argparse.ArgumentParser(prog="python -m assistant.ai.golden")
    p.add_argument("--data", default=None, help="a case file or a folder (default eval/golden)")
    p.add_argument("--kind", action="append", help="only these kinds (repeatable)")
    p.add_argument("--live", action="store_true", help="real providers (keys in env)")
    p.add_argument("--json", default=None, help="also write the metrics as JSON here")
    a = p.parse_args(argv)
    rep = asyncio.run(run_golden(a.data, live=a.live, kinds=set(a.kind) if a.kind else None))
    print(render(rep))
    if a.json:
        Path(a.json).write_text(to_json(rep), encoding="utf-8")
    return 0 if rep.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
