#!/usr/bin/env python3
"""Bounded, read-only entry observations. Persist only finite probe fields."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

if __package__:
    from .wrd_deadline import Deadline, run_owned_probe
else:
    from wrd_deadline import Deadline, run_owned_probe

LAYERS = ('origin-health', 'formal-health', 'login-html', 'viewer-html', 'core-asset', 'passive-runtime')
STAGES = {'dns', 'connect', 'tls', 'headers', 'body', 'content', 'deadline', 'passive'}
REASONS = {'ok', 'not-configured', 'unavailable', 'dns-failed', 'connect-failed', 'tls-failed',
           'timeout', 'deadline-exceeded', 'http-auth', 'http-status', 'health-invalid',
           'content-limit', 'empty-content', 'invalid-target', 'invalid-manifest', 'invalid-response'}
ROUTES = {'origin', 'formal', 'proxy', 'unknown'}
RECOVERABLE = {'dns-failed', 'connect-failed', 'tls-failed', 'http-status', 'health-invalid'}


def probe_result(layer, *, outcome='unknown', stage='content', reason='unavailable',
                 status=None, elapsed=0, timeout=0, proxy='environment', resolver='system',
                 size=0, route=None):
    return {'schemaVersion': 2, 'layer': layer, 'outcome': outcome, 'stage': stage,
            'reason': reason, 'httpStatus': status, 'elapsedMs': max(0, round(elapsed * 1000, 3)),
            'timeoutMs': max(0, round(timeout * 1000, 3)), 'proxyMode': proxy,
            'resolverMode': resolver, 'bytesRead': size,
            'routeClass': route or ('origin' if layer == 'origin-health' else 'formal'),
            'observedAt': datetime.now(timezone.utc).isoformat()}


def sanitize_probe(row, layer):
    """Whitelist child/adapter output before durable state or logging."""
    if not isinstance(row, dict):
        return probe_result(layer, reason='invalid-response')
    import math
    result = probe_result(layer)
    for key, choices in {'outcome': {'ok', 'failed', 'unknown'}, 'stage': STAGES,
                         'reason': REASONS, 'proxyMode': {'environment', 'direct', 'unknown'},
                         'resolverMode': {'system', 'configured-public', 'unknown'}, 'routeClass': ROUTES}.items():
        if row.get(key) in choices:
            result[key] = row[key]
    for key, upper in (('elapsedMs', 15000), ('timeoutMs', 15000), ('bytesRead', 1024 * 1024 + 1)):
        value = row.get(key)
        if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= upper:
            result[key] = value
    stamp = row.get('observedAt')
    if isinstance(stamp, str) and len(stamp) <= 40:
        try:
            parsed_stamp = datetime.fromisoformat(stamp)
            if parsed_stamp.tzinfo:
                result['observedAt'] = parsed_stamp.isoformat()
        except ValueError:
            pass
    status = row.get('httpStatus')
    if type(status) is int and 100 <= status <= 599:
        result['httpStatus'] = status
    return result


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _failure(error):
    error = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(error, socket.gaierror):
        return 'failed', 'dns', 'dns-failed'
    if isinstance(error, ssl.SSLError):
        return 'failed', 'tls', 'tls-failed'
    if isinstance(error, TimeoutError):
        return 'unknown', 'deadline', 'timeout'
    if isinstance(error, (ConnectionError, OSError)):
        return 'failed', 'connect', 'connect-failed'
    return 'unknown', 'content', 'unavailable'


def _classify(layer, status, body, *, limit, headers=None):
    if len(body) > limit:
        return 'failed', 'content', 'content-limit'
    if not 200 <= status < 300:
        return 'failed', 'headers', 'http-auth' if status in {401, 403, 407} else 'http-status'
    if layer.endswith('-health'):
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            payload = None
        if not isinstance(payload, dict) or payload.get('status') != 'ok':
            return 'failed', 'content', 'health-invalid'
    elif not body:
        return 'failed', 'content', 'empty-content'
    return 'ok', 'content', 'ok'


def _http_fetch(target, *, layer, deadline, limit, proxy_mode, opener=None):
    """Worker-only I/O. Parent owns the hard deadline, including blocking DNS/body."""
    handlers = [_NoRedirectHandler()]
    if proxy_mode == 'direct':
        handlers.append(urllib.request.ProxyHandler({}))
    request_opener = opener or urllib.request.build_opener(*handlers)
    request = urllib.request.Request(target, headers={'Accept': 'application/json' if layer.endswith('-health') else '*/*',
                                                     'User-Agent': 'WRD-Entry-Health/2.0'})
    response = request_opener.open(request, timeout=deadline.remaining())
    try:
        status = int(response.status if hasattr(response, 'status') else response.getcode())
        # limit+1 detects truncation instead of treating the prefix as complete.
        body = response.read(limit + 1)
        return status, body, getattr(response, 'headers', {})
    finally:
        response.close()


def _valid_target(target):
    try:
        parsed = urllib.parse.urlsplit(target)
        return parsed.scheme in {'http', 'https'} and bool(parsed.hostname) and not parsed.username and not parsed.password
    except (TypeError, ValueError):
        return False


def _owned_fetch(layer, *, target, deadline, limit, proxy_mode):
    if not _valid_target(target):
        return probe_result(layer, reason='invalid-target', proxy=proxy_mode)
    duration = deadline.remaining()
    command = [sys.executable, str(Path(__file__).resolve()), '--probe-worker', layer,
               '--url', target, '--timeout', str(duration), '--proxy-mode', proxy_mode]
    probe = run_owned_probe(command, deadline=deadline, allowed_executables={sys.executable})
    try:
        if probe['outcome'] == 'ok':
            return sanitize_probe(json.loads(probe['stdout']), layer)
    except (ValueError, TypeError):
        pass
    return probe_result(layer, stage='deadline', reason='deadline-exceeded', timeout=duration, proxy=proxy_mode)


def _observe(layer, target, *, deadline, fetch, now, proxy_mode):
    started, budget = now(), deadline.remaining()
    limit = 1024 * 1024 if layer == 'core-asset' else 64 * 1024
    if deadline.expired():
        return probe_result(layer, stage='deadline', reason='deadline-exceeded', proxy=proxy_mode)
    try:
        response = fetch(layer, target=target, deadline=deadline, limit=limit, proxy_mode=proxy_mode)
        if isinstance(response, dict):
            return sanitize_probe(response, layer)
        status, body, *extra = response
        headers = extra[0] if extra else {}
        outcome, stage, reason = _classify(layer, status, body, limit=limit)
        route = 'proxy' if any(str(key).lower() in {'via', 'proxy-authenticate'} for key in headers) else None
        size = min(len(body), limit + 1)
    except urllib.error.HTTPError as error:
        status, size = int(error.code), 0
        outcome, stage, reason = 'failed', 'headers', 'http-auth' if status in {401, 403, 407} else 'http-status'
        route = 'proxy' if any(str(key).lower() in {'via', 'proxy-authenticate'} for key in (error.headers or {})) else None
        error.close()
    except Exception as error:
        outcome, stage, reason = _failure(error)
        status, size, route = None, 0, None
    if deadline.expired():
        outcome, stage, reason = 'unknown', 'deadline', 'deadline-exceeded'
    return probe_result(layer, outcome=outcome, stage=stage, reason=reason, status=status,
                        elapsed=now()-started, timeout=budget, proxy=proxy_mode, size=size, route=route)


def _asset_path(manifest):
    if not isinstance(manifest, dict):
        return None
    assets = manifest.get('assets', manifest)
    path = assets.get('desktopJs') if isinstance(assets, dict) else None
    if isinstance(path, str) and re.fullmatch(r'assets/[A-Za-z0-9_-]+\.[a-f0-9]{16,64}\.js', path):
        return path
    return None


def probe_layers(config, *, deadline, fetch=None, now=time.monotonic, include_assets=True, proxy_mode='environment'):
    if proxy_mode not in {'environment', 'direct'}:
        raise ValueError('invalid proxy mode')
    fetch = fetch or _owned_fetch
    rows = []
    targets = {'origin-health': config.get('origin'), 'formal-health': config.get('formal')}
    if include_assets:
        targets.update({name: config.get(name) for name in ('login-html', 'viewer-html')})
        asset = _asset_path(config.get('manifest'))
        targets['core-asset'] = urllib.parse.urljoin(config.get('formal', ''), '/' + asset) if asset else None
    for layer, target in targets.items():
        if target:
            # HTML can only be same-origin paths. Never follow manifest URLs or redirects.
            if layer.endswith('-html'):
                formal = urllib.parse.urlsplit(config.get('formal', ''))
                candidate = urllib.parse.urlsplit(urllib.parse.urljoin(config.get('formal', ''), target))
                if (candidate.scheme, candidate.netloc) != (formal.scheme, formal.netloc) or candidate.query or candidate.fragment or '..' in urllib.parse.unquote(target).split('/'):
                    rows.append(probe_result(layer, reason='invalid-target'))
                    continue
                target = urllib.parse.urlunsplit(candidate)
            rows.append(_observe(layer, target, deadline=deadline, fetch=fetch, now=now, proxy_mode=proxy_mode))
        else:
            rows.append(probe_result(layer, reason='invalid-manifest' if layer == 'core-asset' and config.get('manifest') else 'not-configured'))
    # Only consume a pre-existing summary; no login, Socket Viewer or input probe.
    passive = config.get('passive-runtime')
    rows.append(sanitize_probe(passive, 'passive-runtime') if isinstance(passive, dict)
                else probe_result('passive-runtime', stage='passive'))
    return rows


def _default_public_resolver(host, *, deadline):
    probe = run_owned_probe(['nslookup', host, '8.8.8.8'], deadline=deadline, allowed_executables={'nslookup'})
    if probe['outcome'] != 'ok':
        return []
    addresses = re.findall(rb'(?m)^Address:\s*([0-9]+(?:\.[0-9]+){3})\s*$', probe['stdout'])
    return list(dict.fromkeys(ip.decode() for ip in addresses if ip != b'8.8.8.8'))


def _default_resolved_checker(target, host, port, ips, timeout, *, deadline=None, proxy_mode='environment'):
    deadline = deadline or Deadline(timeout)
    for ip in ips:
        if deadline.expired():
            break
        command = ['curl', '--silent', '--max-time', str(deadline.remaining()), '--max-filesize', '65536',
                   '--resolve', f'{host}:{port}:{ip}', '--write-out', '\n__WRD_STATUS__=%{http_code}', target]
        if proxy_mode == 'direct':
            command[1:1] = ['--noproxy', '*']
        probe = run_owned_probe(command, deadline=deadline, allowed_executables={'curl'})
        if probe['outcome'] != 'ok':
            continue
        body, marker, status = probe['stdout'].rpartition(b'\n__WRD_STATUS__=')
        if marker and status.isdigit():
            outcome, stage, reason = _classify('formal-health', int(status), body, limit=65536)
            return probe_result('formal-health', outcome=outcome, stage=stage, reason=reason,
                                status=int(status), resolver='configured-public', proxy=proxy_mode, size=len(body))
    return probe_result('formal-health', stage='deadline', reason='deadline-exceeded', resolver='configured-public', proxy=proxy_mode)


def check_entry(url, *, health_path='/health', timeout=10.0, opener=None, public_resolver=None,
                resolved_checker=None, deadline=None, proxy_mode='environment'):
    deadline = deadline or Deadline(timeout)
    try:
        parsed = urllib.parse.urlsplit(str(url or '').strip())
    except ValueError:
        parsed = urllib.parse.urlsplit('')
    target = urllib.parse.urljoin(urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, '/', '', '')), health_path.lstrip('/'))
    if not _valid_target(target):
        row = probe_result('formal-health', reason='invalid-target')
    else:
        fetch = (lambda layer, **kw: _http_fetch(kw['target'], layer=layer, deadline=kw['deadline'],
                 limit=kw['limit'], proxy_mode=kw['proxy_mode'], opener=opener)) if opener else _owned_fetch
        row = _observe('formal-health', target, deadline=deadline, fetch=fetch, now=deadline.now, proxy_mode=proxy_mode)
        if row['reason'] == 'dns-failed' and parsed.hostname.endswith('.trycloudflare.com') and not deadline.expired():
            ips = public_resolver(parsed.hostname) if public_resolver else _default_public_resolver(parsed.hostname, deadline=deadline)
            if ips and not deadline.expired():
                if resolved_checker:
                    legacy = resolved_checker(target, parsed.hostname, parsed.port or 443, ips, deadline.remaining())
                    row = probe_result('formal-health', outcome='ok' if legacy.get('deliverable') else 'unknown',
                                       reason='ok' if legacy.get('deliverable') else 'unavailable', status=legacy.get('http_status'), resolver='configured-public')
                else:
                    row = _default_resolved_checker(target, parsed.hostname, parsed.port or 443, ips, deadline.remaining(), deadline=deadline, proxy_mode=proxy_mode)
    state = 'deliverable' if row['outcome'] == 'ok' else 'dns-unresolved' if row['reason'] == 'dns-failed' else 'http-invalid' if row['stage'] == 'headers' else 'content-invalid' if row['reason'] == 'health-invalid' else 'origin-unreachable'
    # checked_url is the old in-memory compatibility field. CLI/durable probes omit it.
    return {**row, 'state': state, 'deliverable': row['outcome'] == 'ok', 'http_status': row['httpStatus'], 'checked_url': target}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--health-path', default='/health')
    parser.add_argument('--timeout', type=float, default=10.0)
    parser.add_argument('--proxy-mode', choices=('environment', 'direct'), default='environment')
    parser.add_argument('--probe-worker', choices=LAYERS[:-1])
    args = parser.parse_args(argv)
    deadline = Deadline(args.timeout)
    if args.probe_worker:
        fetch = lambda layer, **kw: _http_fetch(kw['target'], layer=layer, deadline=deadline, limit=kw['limit'], proxy_mode=args.proxy_mode)
        result = _observe(args.probe_worker, args.url, deadline=deadline, fetch=fetch, now=deadline.now, proxy_mode=args.proxy_mode)
        parsed = urllib.parse.urlsplit(args.url)
        if (result['reason'] == 'dns-failed' and args.probe_worker.endswith('-health')
                and parsed.hostname and parsed.hostname.endswith('.trycloudflare.com') and not deadline.expired()):
            ips = _default_public_resolver(parsed.hostname, deadline=deadline)
            if ips and not deadline.expired():
                result = _default_resolved_checker(args.url, parsed.hostname, parsed.port or 443, ips,
                    deadline.remaining(), deadline=deadline, proxy_mode=args.proxy_mode)
                result['layer'] = args.probe_worker
    else:
        result = check_entry(args.url, health_path=args.health_path, deadline=deadline, proxy_mode=args.proxy_mode)
        result.pop('checked_url', None)
    print(json.dumps(result, separators=(',', ':')))
    return 0 if args.probe_worker or result['deliverable'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
