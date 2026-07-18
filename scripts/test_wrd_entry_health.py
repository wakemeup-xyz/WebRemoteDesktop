import json
import socket
import threading
import urllib.error
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from scripts.wrd_entry_health import check_entry


@contextmanager
def health_server(*, status=200, body=None, headers=None):
    response_body = json.dumps(body if body is not None else {"status": "ok"}).encode()
    response_headers = dict(headers or {})

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(status)
            self.send_header("Content-Type", response_headers.get("Content-Type", "application/json"))
            for name, value in response_headers.items():
                if name.lower() != "content-type":
                    self.send_header(name, value)
            self.end_headers()
            self.wfile.write(response_body)

        def log_message(self, _format, *_args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_health_200_json_ok_is_deliverable():
    with health_server() as url:
        result = check_entry(url)

    assert result["state"] == "deliverable"
    assert result["deliverable"] is True
    assert result["http_status"] == 200
    assert result["checked_url"].endswith("/health")


@pytest.mark.parametrize("status", [301, 404, 410, 429, 500, 530])
def test_non_2xx_is_http_invalid(status):
    headers = {"Location": "https://example.invalid/"} if status == 301 else None
    with health_server(status=status, headers=headers) as url:
        result = check_entry(url)

    assert result["state"] == "http-invalid"
    assert result["deliverable"] is False
    assert result["http_status"] == status


@pytest.mark.parametrize("body", [{"status": "wrong"}, ["ok"], "not-json"])
def test_2xx_wrong_body_is_content_invalid(body):
    with health_server(body=body) as url:
        result = check_entry(url)

    assert result["state"] == "content-invalid"
    assert result["deliverable"] is False


def test_dns_failure_uses_public_fallback_only_for_trycloudflare():
    class DnsFailingOpener:
        def open(self, _request, timeout):
            raise urllib.error.URLError(socket.gaierror(-2, "name not known"))

    calls = []

    result = check_entry(
        "https://unit-test.trycloudflare.com",
        opener=DnsFailingOpener(),
        public_resolver=lambda host: ["203.0.113.8"],
        resolved_checker=lambda target, host, port, ips, timeout: calls.append(
            (target, host, port, ips, timeout)
        ) or {
            "state": "deliverable",
            "deliverable": True,
            "http_status": 200,
            "reason": "ok-public-dns",
            "checked_url": target,
        },
    )

    assert result["deliverable"] is True
    assert calls[0][1:4] == ("unit-test.trycloudflare.com", 443, ["203.0.113.8"])


def test_dns_failure_without_public_answer_is_dns_unresolved():
    class DnsFailingOpener:
        def open(self, _request, timeout):
            raise urllib.error.URLError(socket.gaierror(-2, "name not known"))

    result = check_entry(
        "https://unit-test.trycloudflare.com",
        opener=DnsFailingOpener(),
        public_resolver=lambda _host: [],
    )

    assert result["state"] == "dns-unresolved"
    assert result["deliverable"] is False


def test_invalid_url_is_not_deliverable():
    result = check_entry("file:///tmp/not-an-entry")

    assert result["state"] == "origin-unreachable"
    assert result["deliverable"] is False
