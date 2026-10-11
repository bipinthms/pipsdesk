"""Application settings, loaded from environment variables and `backend/.env`.

Credentials are held as `SecretStr` so they never appear in reprs, logs or
tracebacks. Nothing in this module is ever serialised to the frontend.
"""

from __future__ import annotations

import sys
from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        env_ignore_empty=True,
    )

    # --- Broker connection -------------------------------------------------
    mt5_mock: bool = False
    mt5_login: int | None = None
    mt5_password: SecretStr | None = None
    mt5_server: str | None = None
    # Optional explicit path to terminal64.exe (useful when several terminals are installed).
    mt5_path: str | None = None
    mt5_timeout_ms: int = 10_000

    # --- HTTP server -------------------------------------------------------
    app_host: str = "127.0.0.1"
    app_port: int = 8000
    # Comma-separated list of browser origins allowed to call the API.
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    # Extra Host header values accepted besides localhost/127.0.0.1.
    extra_allowed_hosts: str = ""

    # How often the WebSocket stream polls MT5 for changes.
    stream_interval_ms: int = Field(default=300, ge=100, le=2000)

    # Liquid symbol whose tick time stands in for the MT5 server clock (daily reset).
    server_time_symbol: str = "EURUSD"

    # Serve the built UI (frontend/dist) from the backend, so one port does everything.
    serve_frontend: bool = True
    frontend_dist: Path = BACKEND_DIR.parent / "frontend" / "dist"

    # --- Storage -----------------------------------------------------------
    db_path: Path = BACKEND_DIR / "data" / "trading.db"

    # --- Mock mode ---------------------------------------------------------
    # Timezone the simulated trade server keeps its clock in (MT5 reports
    # times in server time, not UTC).
    mock_server_tz: str = "Europe/Athens"
    mock_initial_balance: float = Field(default=100_000.0, gt=0)

    log_level: str = "INFO"

    @model_validator(mode="after")
    def _check_live_requirements(self) -> Settings:
        if self.mt5_mock:
            return self
        if sys.platform != "win32":
            raise ValueError(
                "The MetaTrader5 package only runs on Windows. Set MT5_MOCK=1 to run "
                "with simulated prices, or run the backend on a Windows machine."
            )
        missing = [
            name
            for name, value in (
                ("MT5_LOGIN", self.mt5_login),
                ("MT5_PASSWORD", self.mt5_password),
                ("MT5_SERVER", self.mt5_server),
            )
            if not value
        ]
        if missing:
            raise ValueError(f"Missing required settings for live mode: {', '.join(missing)}")
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        """UI origins: the Vite dev server(s), plus this server itself when it serves the built UI."""
        own = [f"http://127.0.0.1:{self.app_port}", f"http://localhost:{self.app_port}"]
        listed = [o.strip() for o in self.cors_origins.split(",") if o.strip()]
        return listed + [o for o in own if o not in listed]

    @property
    def allowed_hosts(self) -> list[str]:
        extra = [h.strip() for h in self.extra_allowed_hosts.split(",") if h.strip()]
        return ["127.0.0.1", "localhost", *extra]


@lru_cache
def get_settings() -> Settings:
    return Settings()
