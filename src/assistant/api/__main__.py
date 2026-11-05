import uvicorn

from assistant.api.app import create_app
from assistant.config import get_settings
from assistant.logs import configure_logging


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    uvicorn.run(create_app(settings), host=settings.api_host, port=settings.api_port,
                log_config=None, proxy_headers=True)  # fmt: skip


if __name__ == "__main__":
    main()
