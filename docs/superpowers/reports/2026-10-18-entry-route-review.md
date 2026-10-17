# Formal health 403 route audit

Bounded read-only observation, 2026-10-18 CST. Formal origin: `https://link.stockhub.wiki`; path class: `/health`; method: GET. Four probes total, socket timeout 6 seconds and hard process deadline 8 seconds. Redirects disabled. No root HTML, browser, authentication, Viewer, signaling, media, proof, or input checks were performed. No service, tunnel, or watcher changes occurred.

## Findings

- Canonical health user-agent succeeded over the default configured proxy route with HTTP 200 and JSON status=ok.
- Python default user-agent received HTTP 403 on both default and explicit-direct routes.
- Explicit-direct canonical-health user-agent did not yield a status within the hard eight-second process deadline.
- These temporally adjacent probes support request-class sensitivity or intermittent edge behavior; they do not establish the exact cause or a browser, login, signaling, media, or input failure.

A successful canonical health request disproves an all-request entry failure during this observation window. The initial 403 is not explained solely by configured proxy routing because explicit direct routing with the same Python request class also received 403. UA causality is suggestive, not proven: the observations occurred sequentially and one direct canonical request timed out. Do not infer a browser outage or tunnel failure from the 403 alone.

## Observations

| UTC start | CST start | Route class | Request agent class | HTTP | Fixed error class | Elapsed ms | Server class | Content type class | JSON status=ok |
|---|---|---|---|---:|---|---:|---|---|---|
| 2026-10-17T17:26:58.089+00:00 | 2026-10-18T01:26:58.089+08:00 | default-configured-proxy | python-default-ua | 403 | http-non-success | 3174.9 | cloudflare | application/json | None |
| 2026-10-17T17:27:01.544+00:00 | 2026-10-18T01:27:01.544+08:00 | explicit-direct | python-default-ua | 403 | http-non-success | 1654.1 | cloudflare | application/json | None |
| 2026-10-17T17:27:03.512+00:00 | 2026-10-18T01:27:03.512+08:00 | default-configured-proxy | canonical-health-ua | 200 | None | 4422.3 | cloudflare | application/json | True |
| 2026-10-17T17:27:07.965111+00:00 | 2026-10-18T01:27:07.965111+08:00 | explicit-direct | canonical-health-ua | None | process-deadline-8s | 8000 | None | None | None |

Exact UTC end timestamps for completed HTTP responses and the hard deadline for the incomplete probe are recorded in the companion sanitized JSON. `python-default-ua` uses urllib default agent; `canonical-health-ua` sets `Mozilla/5.0 WRD-Entry-Health/1.0`, matching `scripts/wrd_entry_health.py`; both send Accept: application/json.

The existing shell watcher helper prefers the canonical Python checker when present (`scripts/lib-fixed-domain.sh:36`); its curl fallback was not invoked or probed.

## Route context

All upper/lower HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, and NO_PROXY variables were present. Values were not emitted or saved. Default Python proxy-bypass decision for the formal host: False. Default route uses the standard urllib proxy resolver; explicit direct route uses an empty ProxyHandler. No proxy URLs, credentials, IDs, IPs, response bodies, error bodies, session tokens, or runtime secrets appear in the report.

The parent diagnosis independently observed local `/health` HTTP 200 around 01:26 CST; this child performed no additional local HTTP requests. No broader uptime or latency distribution can be inferred from this four-request window.

Evidence: [sanitized summary](evidence/2026-10-18-entry-route/summary.json). No source/index edits or commits.
