"""Entry point: `python -m backend` from the repository root.

Pass `--reload` while developing to restart automatically when backend code changes.
"""

import logging
import sys

import uvicorn

from backend.config import get_settings


def setup_logging() -> None:
    logging.basicConfig(
        level=get_settings().log_level.upper(),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )


def reload_app():
    """App factory for `--reload`: the server then runs in a child process that never calls main()."""
    from backend.api import create_app

    setup_logging()
    return create_app()


def main() -> None:
    settings = get_settings()
    reload = "--reload" in sys.argv[1:]
    setup_logging()
    uvicorn.run(
        "backend.__main__:reload_app" if reload else "backend.api:create_app",
        factory=True,
        host=settings.app_host,
        port=settings.app_port,
        log_level=settings.log_level.lower(),
        reload=reload,
        # Only passed when reloading: uvicorn warns about reload_dirs otherwise.
        **({"reload_dirs": ["backend"]} if reload else {}),
    )


if __name__ == "__main__":
    main()
