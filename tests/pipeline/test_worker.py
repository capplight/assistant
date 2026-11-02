"""worker.run_one without a database: queue functions and the sessionmaker are faked."""

import logging

import httpx

from assistant import worker
from assistant.db import queue
from assistant.db.models import Job
from assistant.logs import configure_logging
from assistant.notify import FakeNotifier

TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ"


class _Session:
    def __init__(self, job):
        self.job = job

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, cls, pk, **_):
        return self.job if cls is Job and pk == self.job.id else None

    async def commit(self):
        pass


def _install(monkeypatch, job, *, gave_up=False):
    recorded = {}

    async def claim(s, kinds):
        return job

    async def fail(s, j, error):
        recorded["last_error"] = error
        return gave_up

    async def complete(s, j):
        recorded["done"] = True

    monkeypatch.setattr(queue, "claim", claim)
    monkeypatch.setattr(queue, "fail", fail)
    monkeypatch.setattr(queue, "complete", complete)
    monkeypatch.setattr(worker, "get_sessionmaker", lambda: (lambda: _Session(job)))
    return recorded


def _token_error() -> httpx.HTTPStatusError:
    req = httpx.Request("POST", f"https://api.telegram.org/bot{TOKEN}/getFile")
    return httpx.HTTPStatusError(
        f"Server error '502 Bad Gateway' for url '{req.url}'", request=req,
        response=httpx.Response(502, request=req),
    )  # fmt: skip


async def test_job_error_with_token_url_is_redacted(monkeypatch, caplog):
    job = Job(id=1, kind="process_item", payload={"item_id": 5})
    recorded = _install(monkeypatch, job, gave_up=True)
    failed_items = []

    async def process_item(s, item_id, notifier, deps):
        raise _token_error()

    async def fail_item(s, item_id, error, notifier):
        failed_items.append(error)

    monkeypatch.setattr(worker, "process_item", process_item)
    monkeypatch.setattr(worker, "fail_item", fail_item)
    with caplog.at_level(logging.INFO):
        assert await worker.run_one(FakeNotifier(), deps=None) is True
    assert TOKEN not in recorded["last_error"] and "502" in recorded["last_error"]
    assert failed_items and TOKEN not in failed_items[0]


async def test_fail_item_error_does_not_break_the_loop(monkeypatch):
    job = Job(id=1, kind="process_item", payload={"item_id": 5})
    _install(monkeypatch, job, gave_up=True)

    async def process_item(s, item_id, notifier, deps):
        raise RuntimeError("x")

    async def fail_item(s, item_id, error, notifier):
        raise RuntimeError("db down")

    monkeypatch.setattr(worker, "process_item", process_item)
    monkeypatch.setattr(worker, "fail_item", fail_item)
    assert await worker.run_one(FakeNotifier(), deps=None) is True


async def test_success_completes_job(monkeypatch):
    job = Job(id=1, kind="process_item", payload={"item_id": 5})
    recorded = _install(monkeypatch, job)

    async def process_item(s, item_id, notifier, deps):
        return None

    monkeypatch.setattr(worker, "process_item", process_item)
    assert await worker.run_one(FakeNotifier(), deps=None) is True
    assert recorded == {"done": True}


def test_configured_logging_redacts_tokens_and_silences_httpx(capsys):
    root = logging.getLogger()
    saved = root.handlers[:], root.level
    try:
        configure_logging("INFO")
        logging.getLogger("httpx").info("HTTP Request: POST https://x/bot%s/getFile", TOKEN)
        logging.getLogger("assistant.worker").warning("failed: %s", _token_error())
        err = capsys.readouterr().err
    finally:
        root.handlers[:] = saved[0]
        root.setLevel(saved[1])
        logging.getLogger("httpx").setLevel(logging.NOTSET)
        logging.getLogger("httpcore").setLevel(logging.NOTSET)
    assert TOKEN not in err and "HTTP Request" not in err and "failed:" in err
