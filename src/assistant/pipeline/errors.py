"""Error classification for the pipeline.

Transient errors are re-raised so the job queue retries with backoff. Permanent errors mark
the item FAILED and tell the user; NeedsInputError asks the user for something we can read.
"""

import anthropic
import httpx


class PermanentError(Exception):
    """Retrying will not help (unreadable input, model refusal, invalid request)."""


class NeedsInputError(Exception):
    """We cannot extract anything without the user's help. `user_text` is sent as-is."""

    def __init__(self, user_text: str, reason: str = "") -> None:
        super().__init__(reason or user_text)
        self.user_text = user_text


_TRANSIENT_ANTHROPIC = (
    anthropic.RateLimitError,
    anthropic.OverloadedError,
    anthropic.InternalServerError,
    anthropic.ServiceUnavailableError,
    anthropic.DeadlineExceededError,
    anthropic.APIConnectionError,  # includes APITimeoutError
    # Config problems: retrying gives an operator time to fix the key before the job gives up.
    anthropic.AuthenticationError,
    anthropic.PermissionDeniedError,
)

_PERMANENT_ANTHROPIC = (
    anthropic.BadRequestError,
    anthropic.UnprocessableEntityError,
    anthropic.RequestTooLargeError,
    anthropic.NotFoundError,
)


def is_transient(exc: BaseException) -> bool:
    if isinstance(exc, _TRANSIENT_ANTHROPIC):
        return True
    if isinstance(exc, anthropic.APIStatusError):
        return exc.status_code == 429 or exc.status_code >= 500
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        return code == 429 or code >= 500
    if isinstance(exc, httpx.TransportError):
        return True
    return isinstance(exc, TimeoutError | ConnectionError)


def is_permanent(exc: BaseException) -> bool:
    if isinstance(exc, PermanentError | NeedsInputError):
        return True
    if isinstance(exc, _PERMANENT_ANTHROPIC):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return not is_transient(exc)
    return False
