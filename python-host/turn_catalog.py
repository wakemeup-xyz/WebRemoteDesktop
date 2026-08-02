"""TURN multi-server catalog loader for python-host.

Mirrors signal-server/lib/turn-config.js selection rules closely enough that the
same turn.json yields the same default id and per-server fingerprints.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional


def split_env_list(value: Any) -> List[str]:
    if isinstance(value, (list, tuple)):
        return [str(item).strip() for item in value if str(item or "").strip()]
    return [item.strip() for item in str(value or "").split(",") if item.strip()]


def default_turn_json_path(env: Optional[Dict[str, str]] = None) -> str:
    env = env if env is not None else os.environ
    configured = str(env.get("WRD_TURN_JSON") or "").strip()
    if configured:
        return configured
    return str(Path.home() / ".StockHub" / "turn.json")


def normalize_transport(value: Any) -> str:
    transport = str(value or "udp").strip().lower()
    if transport in {"udp", "tcp"}:
        return transport
    return "udp"


def build_turn_url(host: str, port: Any, transport: Any = "udp") -> str:
    safe_host = str(host or "").strip()
    try:
        safe_port = int(port)
    except (TypeError, ValueError):
        return ""
    if not safe_host or safe_port <= 0 or safe_port > 65535:
        return ""
    return f"turn:{safe_host}:{safe_port}?transport={normalize_transport(transport)}"


def normalize_turn_url(url: Any) -> str:
    raw = str(url or "").strip()
    if not raw:
        return ""
    match = re.match(r"^(turns?):([^?]+)(?:\?(.*))?$", raw, flags=re.IGNORECASE)
    if not match:
        return raw
    scheme = match.group(1).lower()
    host_port = match.group(2).strip()
    query = match.group(3) or ""
    transport = "udp"
    for part in query.split("&"):
        if not part:
            continue
        key, _, value = part.partition("=")
        if key.strip().lower() == "transport" and value.strip():
            candidate = value.strip().lower()
            transport = candidate if candidate in {"udp", "tcp"} else "udp"
            break
    return f"{scheme}:{host_port}?transport={transport}"


def normalize_turn_urls(value: Any) -> List[str]:
    normalized: List[str] = []
    for item in split_env_list(value):
        url = normalize_turn_url(item)
        if url and url not in normalized:
            normalized.append(url)
    return normalized


def sanitize_turn_id(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    cleaned = re.sub(r"[^a-zA-Z0-9._一-鿿-]+", "-", raw)
    cleaned = cleaned.strip("-")
    return cleaned[:64]


def slug_from_remark(remark: Any) -> str:
    text = str(remark or "").strip()
    if not text:
        return ""
    if re.search(r"阿里云|aliyun", text, flags=re.IGNORECASE):
        return "aliyun"
    if re.search(r"海外|overseas|abroad|intl", text, flags=re.IGNORECASE):
        return "overseas"
    return sanitize_turn_id(re.sub(r"\s+", "-", text.lower()))


def slug_from_realm(realm: Any) -> str:
    text = str(realm or "").strip().lower()
    if not text:
        return ""
    return sanitize_turn_id(text.split(".")[0])


def slug_from_host(host: Any) -> str:
    text = str(host or "").strip().lower()
    if not text:
        return ""
    return sanitize_turn_id(text.replace(".", "-"))


def is_preferred_aliyun(server: Dict[str, Any]) -> bool:
    region = str(server.get("region") or "").strip().lower()
    if region in {"cn", "aliyun", "china"}:
        return True
    blob = " ".join(
        str(server.get(key) or "")
        for key in ("id", "remark", "label", "realm", "host")
    )
    return bool(re.search(r"阿里云|aliyun|ali\.yun", blob, flags=re.IGNORECASE))


def get_turn_fingerprint(turn_urls: Any = None, username: Any = None) -> str:
    urls = sorted(normalize_turn_urls(turn_urls))
    user = str(username or "").strip()
    if not urls:
        return ""
    material = f"{','.join(urls)}|{user}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def entry_configured(entry: Dict[str, Any]) -> bool:
    urls = entry.get("urls") or []
    return bool(urls and entry.get("username") and entry.get("credential"))


def normalize_entry(raw: Dict[str, Any], index: int = 0) -> Dict[str, Any]:
    host = str(raw.get("host") or "").strip()
    try:
        port = int(raw.get("port") or 3478)
    except (TypeError, ValueError):
        port = 3478
    transport = normalize_transport(raw.get("transport"))
    urls: List[str] = []
    built = build_turn_url(host, port, transport)
    if built:
        urls.append(built)
    for extra in split_env_list(raw.get("urls") or raw.get("TURN_URLS") or ""):
        normalized = normalize_turn_url(extra)
        if normalized and normalized not in urls:
            urls.append(normalized)
    urls = normalize_turn_urls(urls)
    username = str(raw.get("username") or raw.get("user") or "").strip()
    credential = str(raw.get("password") or raw.get("credential") or "").strip()
    remark = str(raw.get("remark") or raw.get("label") or "").strip()
    realm = str(raw.get("realm") or "").strip()
    region = str(raw.get("region") or "").strip()
    try:
        priority = int(raw.get("priority"))
    except (TypeError, ValueError):
        priority = 0
    explicit_id = sanitize_turn_id(raw.get("id"))
    entry = {
        "id": explicit_id,
        "host": host,
        "port": port,
        "transport": transport,
        "urls": urls,
        "username": username,
        "credential": credential,
        "realm": realm,
        "remark": remark,
        "label": remark or host or explicit_id or f"turn-{index + 1}",
        "region": region,
        "priority": priority,
        "source": str(raw.get("source") or "json"),
    }
    entry["configured"] = entry_configured(entry)
    entry["fingerprint"] = get_turn_fingerprint(entry["urls"], entry["username"]) if entry["urls"] else ""
    entry["preferred"] = is_preferred_aliyun(entry)
    return entry


def assign_stable_turn_ids(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    used = set()
    result: List[Dict[str, Any]] = []
    for index, entry in enumerate(entries):
        candidates = [
            entry.get("id"),
            slug_from_remark(entry.get("remark")),
            slug_from_realm(entry.get("realm")),
            slug_from_host(entry.get("host")),
            f"turn-{index + 1}",
        ]
        base = next((sanitize_turn_id(item) for item in candidates if sanitize_turn_id(item)), f"turn-{index + 1}")
        turn_id = base
        suffix = 2
        while turn_id in used:
            turn_id = f"{base}-{suffix}"[:64]
            suffix += 1
        used.add(turn_id)
        next_entry = dict(entry)
        next_entry["id"] = turn_id
        next_entry["label"] = next_entry.get("remark") or next_entry.get("host") or turn_id
        next_entry["preferred"] = is_preferred_aliyun(next_entry)
        result.append(next_entry)
    return result


def pick_default_turn_server_id(
    servers: List[Dict[str, Any]],
    *,
    env: Optional[Dict[str, str]] = None,
    default_turn_server_id: str = "",
) -> str:
    env = env if env is not None else {}
    configured = [server for server in servers if server.get("configured")]
    if not configured:
        return str(servers[0].get("id") or "") if servers else ""

    env_id = sanitize_turn_id(env.get("WRD_TURN_SERVER_ID") or env.get("TURN_SERVER_ID") or "")
    if env_id and any(server.get("id") == env_id for server in configured):
        return env_id

    file_default = sanitize_turn_id(default_turn_server_id)
    if file_default and any(server.get("id") == file_default for server in configured):
        return file_default

    aliyun = sorted(
        [server for server in configured if is_preferred_aliyun(server)],
        key=lambda item: int(item.get("priority") or 0),
        reverse=True,
    )
    if aliyun:
        return str(aliyun[0].get("id") or "")

    by_priority = sorted(configured, key=lambda item: int(item.get("priority") or 0), reverse=True)
    return str(by_priority[0].get("id") or "")


def resolve_turn_server(catalog: Dict[str, Any], turn_server_id: Any = None) -> Optional[Dict[str, Any]]:
    servers = list(catalog.get("servers") or [])
    requested = sanitize_turn_id(turn_server_id)
    if requested:
        for server in servers:
            if server.get("id") == requested:
                return server
    default_id = str(catalog.get("defaultId") or "").strip()
    if default_id:
        for server in servers:
            if server.get("id") == default_id:
                return server
    for server in servers:
        if server.get("configured"):
            return server
    return servers[0] if servers else None


def _read_turn_json_document(file_path: str) -> Dict[str, Any]:
    resolved = str(file_path or "").strip()
    if not resolved:
        return {
            "entries": [],
            "defaultTurnServerId": "",
            "sourcePath": "",
            "loaded": False,
            "error": "missing-path",
        }
    path = Path(resolved)
    if not path.exists():
        return {
            "entries": [],
            "defaultTurnServerId": "",
            "sourcePath": resolved,
            "loaded": False,
            "error": "not-found",
        }
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - surface parse errors like Node loader
        return {
            "entries": [],
            "defaultTurnServerId": "",
            "sourcePath": resolved,
            "loaded": False,
            "error": str(exc),
        }

    default_turn_server_id = ""
    entries: List[Dict[str, Any]] = []
    if isinstance(parsed, dict):
        default_turn_server_id = str(parsed.get("defaultTurnServerId") or "").strip()
        raw_servers = parsed.get("turnServers")
        if isinstance(raw_servers, list):
            for index, item in enumerate(raw_servers):
                if isinstance(item, dict):
                    entries.append(normalize_entry({**item, "source": "json"}, index))
        legacy = parsed.get("turnServer")
        if isinstance(legacy, dict):
            entry = normalize_entry({**legacy, "source": "json"}, len(entries))
            if not entry.get("id"):
                entry["id"] = "legacy"
            key = (
                ",".join(sorted(entry.get("urls") or [])),
                entry.get("username") or "",
            )
            if not any(
                (
                    ",".join(sorted(existing.get("urls") or [])),
                    existing.get("username") or "",
                )
                == key
                for existing in entries
            ):
                entries.append(entry)
        if (
            not entries
            and not isinstance(parsed.get("turnServers"), list)
            and (parsed.get("host") or parsed.get("urls") or parsed.get("TURN_URLS"))
        ):
            entries.append(normalize_entry({**parsed, "source": "json"}, 0))

    return {
        "entries": entries,
        "defaultTurnServerId": default_turn_server_id,
        "sourcePath": resolved,
        "loaded": True,
        "error": "",
    }


def load_turn_catalog(
    env: Optional[Dict[str, str]] = None,
    json_path: Optional[str] = None,
) -> Dict[str, Any]:
    env_map = dict(env if env is not None else os.environ)
    resolved_path = default_turn_json_path(env_map) if json_path is None else str(json_path or "").strip()
    doc = _read_turn_json_document(resolved_path) if resolved_path else {
        "entries": [],
        "defaultTurnServerId": "",
        "sourcePath": "",
        "loaded": False,
        "error": "missing-path",
    }

    servers = assign_stable_turn_ids([dict(entry) for entry in doc.get("entries") or []])
    env_urls = normalize_turn_urls(env_map.get("TURN_URLS"))
    env_username = str(env_map.get("TURN_USERNAME") or "").strip()
    env_credential = str(env_map.get("TURN_CREDENTIAL") or "").strip()
    env_has_urls = bool(env_urls)
    env_has_creds = bool(env_username or env_credential)
    env_complete = bool(env_has_urls and env_username and env_credential)
    env_provided = env_has_urls or env_has_creds

    if env_complete or (env_provided and not servers):
        env_server = normalize_entry(
            {
                "id": "env",
                "host": "",
                "port": 3478,
                "transport": "udp",
                "urls": ",".join(env_urls),
                "username": env_username,
                "password": env_credential,
                "remark": "环境变量",
                "source": "env",
                "priority": 1000,
            },
            0,
        )
        env_server["id"] = "env"
        env_server["label"] = "环境变量"
        env_server["preferred"] = False
        servers = [env_server] + [server for server in servers if server.get("id") != "env"]
    elif env_provided and servers:
        provisional_default = pick_default_turn_server_id(
            servers,
            env=env_map,
            default_turn_server_id=doc.get("defaultTurnServerId") or "",
        )
        target = next((server for server in servers if server.get("id") == provisional_default), servers[0])
        if env_has_urls:
            target["urls"] = list(env_urls)
        if env_username:
            target["username"] = env_username
        if env_credential:
            target["credential"] = env_credential
        target["configured"] = entry_configured(target)
        target["fingerprint"] = (
            get_turn_fingerprint(target["urls"], target["username"]) if target.get("urls") else ""
        )
        if env_has_urls or env_username or env_credential:
            target["source"] = "mixed" if target.get("source") == "json" else (target.get("source") or "env")

    servers = assign_stable_turn_ids(servers)
    for server in servers:
        server["configured"] = entry_configured(server)
        server["fingerprint"] = (
            get_turn_fingerprint(server.get("urls"), server.get("username")) if server.get("urls") else ""
        )
        server["preferred"] = is_preferred_aliyun(server)
        server["label"] = server.get("remark") or server.get("host") or server.get("id")

    if env_complete:
        for server in servers:
            if server.get("source") == "env" and server.get("remark") == "环境变量":
                server["id"] = "env"
                server["label"] = "环境变量"
                server["preferred"] = False

    default_id = pick_default_turn_server_id(
        servers,
        env=env_map,
        default_turn_server_id=doc.get("defaultTurnServerId") or "",
    )
    if env_complete:
        default_id = "env"
        # If env merely re-exports a json node (same fingerprint), prefer that node's id
        # so Host capability labels match Viewer (e.g. aliyun instead of env).
        env_server = next((server for server in servers if server.get("id") == "env"), None)
        if env_server and env_server.get("fingerprint"):
            twin = next(
                (
                    server for server in servers
                    if server.get("id") != "env"
                    and server.get("configured")
                    and server.get("fingerprint") == env_server.get("fingerprint")
                ),
                None,
            )
            if twin and twin.get("id"):
                default_id = str(twin.get("id"))

    source = "none"
    if any(server.get("urls") or server.get("username") or server.get("credential") for server in servers):
        if env_complete:
            source = "env"
        elif env_provided and doc.get("loaded") and doc.get("entries"):
            source = "mixed"
        elif env_provided and not doc.get("entries"):
            source = "env"
        elif doc.get("loaded") and doc.get("entries"):
            source = "json"
        elif env_provided:
            source = "env"

    return {
        "servers": servers,
        "defaultId": default_id,
        "source": source,
        "jsonPath": doc.get("sourcePath") or resolved_path or "",
        "jsonLoaded": bool(doc.get("loaded")),
        "jsonError": doc.get("error") or "",
        "fileDefaultTurnServerId": doc.get("defaultTurnServerId") or "",
    }


_CATALOG_CACHE: Optional[Dict[str, Any]] = None


def get_cached_turn_catalog(force_reload: bool = False) -> Dict[str, Any]:
    global _CATALOG_CACHE
    if force_reload or _CATALOG_CACHE is None:
        _CATALOG_CACHE = load_turn_catalog()
    return _CATALOG_CACHE


def reset_turn_catalog_cache() -> None:
    global _CATALOG_CACHE
    _CATALOG_CACHE = None
