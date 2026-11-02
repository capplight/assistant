"""Logging setup for every entry point, plus secret redaction for logs and DB error columns.

The Telegram Bot API puts the bot token in the URL path (/bot<token>/getFile), so any
logged URL or httpx exception text would leak it.
"""

import logging
import re

_BOT_TOKEN_RE = re.compile(r"bot\d{5,}:[A-Za-z0-9_-]{20,}")
_BEARER_RE = re.compile(r"(Bearer\s+)[A-Za-z0-9._-]{10,}", re.IGNORECASE)
_KEY_PARAM_RE = re.compile(r"((?:key|token|access_token)=)[^&\s]+", re.IGNORECASE)


def redact(text: str) -> str:
    """Strip bot tokens, bearer tokens and key=/token= query params from text."""
    text = _BOT_TOKEN_RE.sub("bot<redacted>", text)
    text = _BEARER_RE.sub(r"\1<redacted>", text)
    return _KEY_PARAM_RE.sub(r"\1<redacted>", text)


def error_text(exc: BaseException, limit: int = 4000) -> str:
    """Safe string for logs and *.error / last_error columns."""
    return redact(f"{type(exc).__name__}: {exc}")[:limit]


class _RedactFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(record.getMessage())
        record.args = None
        if record.exc_info and record.exc_info[1] is not None:
            # Formatted traceback is built later from exc_info; pre-render it redacted.
            record.exc_text = redact(logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        return True


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    handler.addFilter(_RedactFilter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    # httpx logs every request URL at INFO, including /bot<token>/ paths.
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
