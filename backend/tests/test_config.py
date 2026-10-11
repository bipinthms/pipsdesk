"""Settings that guard the API: loopback bind and trusted browser origins."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.config import Settings


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.20", "::", "pipdesk.example"])
def test_api_never_binds_beyond_loopback(host):
    with pytest.raises(ValidationError, match="loopback"):
        Settings(_env_file=None, mt5_mock=True, app_host=host)


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1"])
def test_loopback_hosts_are_fine(host):
    assert Settings(_env_file=None, mt5_mock=True, app_host=host).app_host == host


def test_mock_mode_trusts_the_vite_dev_server():
    origins = Settings(_env_file=None, mt5_mock=True).cors_origin_list
    assert "http://127.0.0.1:5173" in origins and "http://127.0.0.1:8000" in origins


def test_live_mode_trusts_only_the_app_itself_by_default():
    live = Settings.model_construct(mt5_mock=False, cors_origins=None, app_port=8000)  # live can't validate off Windows
    assert live.cors_origin_list == ["http://127.0.0.1:8000", "http://localhost:8000"]


def test_explicit_origins_are_honoured():
    s = Settings(_env_file=None, mt5_mock=True, cors_origins="http://127.0.0.1:5174")
    assert s.cors_origin_list == ["http://127.0.0.1:5174", "http://127.0.0.1:8000", "http://localhost:8000"]
