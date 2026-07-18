#!/usr/bin/env python3
"""Canonical delivery health check for WebRemoteDesktop public entries."""

from __future__ import annotations

import argparse
import json
import re
import socket
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, TypedDict


class EntryHealthResult(TypedDict):
    state: str
    deliverable: bool
    http_status: int | None
    reason: str
    checked_url: str


def _result(
    state: str,
    deliverable: bool,
    http_status: int | None,
    reason: str,
    checked_url: str,
) -> EntryHealthResult:
    return {
        "state": state,
        "deliverable": deliverable,
        "http_status": http_status,
        "reason": reason,
        "checked_url": checked_url,
    }


def _validate_payload(body: bytes, status: int, target: str) -> EntryHealthResult:
    if not 200 <= status < 300:
        return _result("http-invalid", False, status, "non-2xx", target)
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        return _result("content-invalid", False, status, type(error).__name__, target)
    if not isinstance(payload, dict) or payload.get("status") != "ok":
        return _result("content-invalid", False, status, "health-status-not-ok", target)
    return _result("deliverable", True, status, "ok", target)


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _default_public_resolver(host: str) -> list[str]:
    try:
        completed = subprocess.run(
            ["nslookup", host, "8.8.8.8"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    addresses = re.findall(r"(?m)^Address:\s*([0-9]+(?:\.[0-9]+){3})\s*$", completed.stdout)
    return list(dict.fromkeys(address for address in addresses if address != "8.8.8.8"))


def _default_resolved_checker(
    target: str,
    host: str,
    port: int,
    ips: list[str],
    timeout: float,
) -> EntryHealthResult:
    last_reason = "public-dns-origin-unreachable"
    marker = "\n__WRD_HTTP_STATUS__="
    for ip in ips:
        try:
            completed = subprocess.run(
                [
                    "curl",
                    "--silent",
                    "--show-error",
                    "--max-time",
                    str(timeout),
                    "--resolve",
                    f"{host}:{port}:{ip}",
                    "--header",
                    "Accept: application/json",
                    "--user-agent",
                    "Mozilla/5.0 WRD-Entry-Health/1.0",
                    "--write-out",
                    marker + "%{http_code}",
                    target,
                ],
                check=False,
                capture_output=True,
                timeout=timeout + 2,
            )
        except (OSError, subprocess.SubprocessError) as error:
            last_reason = type(error).__name__
            continue
        if completed.returncode != 0:
            last_reason = completed.stderr.decode("utf-8", errors="replace").strip()[:240]
            continue
        body, separator, status_text = completed.stdout.rpartition(marker.encode())
        if not separator or not status_text.isdigit():
            last_reason = "missing-http-status"
            continue
        return _validate_payload(body, int(status_text), target)
    return _result("origin-unreachable", False, None, last_reason, target)


def _is_dns_error(error: BaseException) -> bool:
    if isinstance(error, socket.gaierror):
        return True
    if isinstance(error, urllib.error.URLError):
        return isinstance(error.reason, socket.gaierror)
    return False


def check_entry(
    url: str,
    *,
    health_path: str = "/health",
    timeout: float = 10.0,
    opener=None,
    public_resolver: Callable[[str], list[str]] | None = None,
    resolved_checker: Callable[[str, str, int, list[str], float], EntryHealthResult] | None = None,
) -> EntryHealthResult:
    parsed = urllib.parse.urlsplit(str(url or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return _result("origin-unreachable", False, None, "invalid-url", str(url or ""))
    origin = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/", "", ""))
    target = urllib.parse.urljoin(origin, health_path.lstrip("/"))
    request = urllib.request.Request(
        target,
        headers={
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 WRD-Entry-Health/1.0",
        },
    )
    request_opener = opener or urllib.request.build_opener(_NoRedirectHandler())
    try:
        response = request_opener.open(request, timeout=timeout)
        status = int(getattr(response, "status", response.getcode()))
        body = response.read(64 * 1024)
        response.close()
        return _validate_payload(body, status, target)
    except urllib.error.HTTPError as error:
        return _result("http-invalid", False, int(error.code), str(error.reason), target)
    except (socket.gaierror, urllib.error.URLError, TimeoutError, OSError) as error:
        if _is_dns_error(error):
            if parsed.hostname.endswith(".trycloudflare.com"):
                resolver = public_resolver or _default_public_resolver
                ips = resolver(parsed.hostname)
                if ips:
                    checker = resolved_checker or _default_resolved_checker
                    port = parsed.port or (443 if parsed.scheme == "https" else 80)
                    return checker(target, parsed.hostname, port, ips, timeout)
            return _result("dns-unresolved", False, None, str(error), target)
        return _result("origin-unreachable", False, None, str(error), target)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--health-path", default="/health")
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args(argv)
    result = check_entry(args.url, health_path=args.health_path, timeout=args.timeout)
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    return 0 if result["deliverable"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
