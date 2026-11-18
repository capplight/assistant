"""Device test 2026-11-18: a request's DB work is committed BEFORE its response goes out.

With the FastAPI default scope ("request") `get_db` committed after the client already had the
answer: the session that /auth/anonymous or /auth/refresh had just issued was not there yet for
the very next call, which then got 401. No database: a fake session records the order."""

from types import SimpleNamespace

from fastapi import FastAPI

from assistant.api.deps import Db, get_ctx


class FakeSession:
    def __init__(self, log: list[str]) -> None:
        self.log = log

    async def __aenter__(self) -> "FakeSession":
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def commit(self) -> None:
        self.log.append("commit")

    async def rollback(self) -> None:
        self.log.append("rollback")


async def test_commit_happens_before_the_response_is_sent() -> None:
    log: list[str] = []
    app = FastAPI()
    ctx = SimpleNamespace(sessionmaker=lambda: FakeSession(log))
    app.dependency_overrides[get_ctx] = lambda: ctx

    @app.post("/write")
    async def write(db: Db) -> dict[str, bool]:
        log.append("handler")
        return {"ok": True}

    sent = False

    async def receive() -> dict[str, object]:
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, object]) -> None:
        log.append(str(message["type"]))

    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
             "scheme": "http", "path": "/write", "raw_path": b"/write", "query_string": b"",
             "headers": [], "client": ("t", 1), "server": ("test", 80), "root_path": ""}
    await app(scope, receive, send)
    assert log.index("commit") < log.index("http.response.start"), log
