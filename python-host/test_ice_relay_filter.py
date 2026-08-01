# python-host/test_ice_relay_filter.py
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from host import (
    build_ice_servers,
    filter_sdp_ice_candidates,
    should_emit_ice_candidate,
)


HOST_LINE = "candidate:1 1 udp 2122260223 192.168.0.106 54321 typ host"
SRFLX_LINE = "candidate:2 1 udp 1686052607 120.229.11.141 12345 typ srflx raddr 192.168.0.106 rport 54321"
RELAY_LINE = "candidate:3 1 udp 41819902 144.225.130.238 60000 typ relay raddr 192.168.0.106 rport 54321"


def test_should_emit_relay_mode_keeps_only_relay():
    assert should_emit_ice_candidate("relay", HOST_LINE) is False
    assert should_emit_ice_candidate("relay", SRFLX_LINE) is False
    assert should_emit_ice_candidate("relay", RELAY_LINE) is True
    assert should_emit_ice_candidate("relay", "candidate:" + RELAY_LINE) is True


def test_should_emit_non_relay_mode_keeps_all():
    assert should_emit_ice_candidate("auto", HOST_LINE) is True
    assert should_emit_ice_candidate("stun", SRFLX_LINE) is True


def test_filter_sdp_ice_candidates_relay_drops_host_srflx():
    sdp = "\r\n".join(
        [
            "v=0",
            "a=group:BUNDLE 0",
            f"a={HOST_LINE}",
            f"a={SRFLX_LINE}",
            f"a={RELAY_LINE}",
            "a=end-of-candidates",
            "",
        ]
    )
    filtered = filter_sdp_ice_candidates("relay", sdp)
    assert "typ host" not in filtered
    assert "typ srflx" not in filtered
    assert "typ relay" in filtered
    assert "a=end-of-candidates" in filtered
    assert "a=group:BUNDLE 0" in filtered


def test_build_ice_servers_relay_omits_stun(monkeypatch):
    monkeypatch.setenv("STUN_URLS", "stun:stun.l.google.com:19302")
    monkeypatch.setenv("TURN_URLS", "turn:144.225.130.238:3478?transport=udp")
    monkeypatch.setenv("TURN_USERNAME", "u")
    monkeypatch.setenv("TURN_CREDENTIAL", "p")
    servers = build_ice_servers("relay")
    urls = []
    for server in servers:
        raw = server.urls if hasattr(server, "urls") else server.get("urls")
        if isinstance(raw, (list, tuple)):
            urls.extend(raw)
        else:
            urls.append(raw)
    joined = " ".join(str(u) for u in urls)
    assert "turn:" in joined
    assert "stun:" not in joined
    assert len(servers) == 1
