"""Pure, persistable watcher state. Only its coordinator may change services."""

from __future__ import annotations

import copy
import math

if __package__:
    from .wrd_entry_health import sanitize_probe, LAYERS, RECOVERABLE
else:
    from wrd_entry_health import sanitize_probe, LAYERS, RECOVERABLE


LATENCY_HISTORY_LIMIT = 120
LATENCY_PROFILE = 'http-compressed-v1'
DEFAULT_LATENCY_BUDGETS_MS = {
    'origin-health': 2000.0,
    'formal-health': 3000.0,
    'login-html': 3000.0,
    'viewer-html': 3000.0,
    'core-asset': 4000.0,
    'passive-runtime': 1500.0,
}


class WatchRuntime:
    def __init__(self, *, state=None, clock_epoch, fail_s=180, cooldown_s=300,
                 window_s=3600, max_recoveries=2, latency_budgets_ms=None):
        self.fail_s, self.cooldown_s = fail_s, cooldown_s
        self.window_s, self.max_recoveries = window_s, max_recoveries
        self.latency_budgets_ms = {**DEFAULT_LATENCY_BUDGETS_MS,
                                   **(latency_budgets_ms or {})}
        self.state = copy.deepcopy(state) if isinstance(state, dict) else {}
        self.state.setdefault("version", 1)
        self.state.setdefault("operation", None)
        self.state.setdefault("recoveries", [])
        self.state.setdefault("failStartedAt", None)
        self.state.setdefault("cooldownUntil", None)
        self.state.setdefault("quarantineUntil", None)
        self.state.setdefault("quarantinedCount", 0)
        self.state.setdefault("lastMono", None)
        self.state.setdefault("assetsObserved", False)
        self.state.setdefault("latencyHistory", {})
        self.state.setdefault("latency", {})
        self.state.setdefault("latencyMode", None)
        previous_profile = self.state.get("latencyProfile")
        if previous_profile != LATENCY_PROFILE:
            self.state["latencyHistory"] = {}
            self.state["latency"] = {}
            self.state["slowLayers"] = []
        self.state["latencyProfile"] = LATENCY_PROFILE
        self.state.setdefault("slowLayers", [])
        old_epoch = self.state.get("clockEpoch")
        if old_epoch != clock_epoch and state:
            self.state["quarantinedCount"] = max(self.state["quarantinedCount"], len(self.state["recoveries"]))
            self.state["recoveries"] = []
            self.state["failStartedAt"] = None
            self.state["cooldownUntil"] = None
            self.state["quarantineUntil"] = None
            self.state["clockUntrusted"] = True
            self.state["lastMono"] = None
            if self.state["operation"] and self.state["operation"].get("state") != "terminal":
                self.state["operation"]["state"] = "unknown"
        self.state["clockEpoch"] = clock_epoch
        self.state["action"] = "none"

    @staticmethod
    def _time(value):
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise ValueError("finite monotonic timestamp required")
        return value

    def tick(self, now_mono, observations):
        now = self._time(now_mono)
        previous = self.state.get("lastMono")
        if previous is not None and now < previous:
            self.state["clockUntrusted"] = True
            self.state["quarantineUntil"] = None
            self.state["quarantinedCount"] = max(self.state["quarantinedCount"], len(self.state["recoveries"]))
            self.state["recoveries"] = []
            self.state["failStartedAt"] = None
        if self.state.get("clockUntrusted"):
            self.state["quarantineUntil"] = now + self.window_s
            self.state["clockUntrusted"] = False
        self.state["lastMono"] = now
        layered = 'probes' in observations
        if layered:
            raw = observations.get('probes')
            raw = raw if isinstance(raw, list) else []
            rows = []
            for layer in LAYERS:
                matches = [row for row in raw[:6] if isinstance(row, dict) and row.get('layer') == layer]
                if len(matches) == 1:
                    rows.append(sanitize_probe(matches[0], layer))
            self.state['probeLayers'] = rows
            by_layer = {row['layer']: row for row in rows}
            self._observe_latency(rows)
            def health_value(layer):
                row = by_layer.get(layer)
                if not row or row['outcome'] == 'unknown':
                    return None
                if row['outcome'] == 'ok' and row['reason'] == 'ok':
                    return True
                if row['outcome'] == 'failed' and row['reason'] in RECOVERABLE:
                    # An environment-proxy observation is not an independent
                    # formal-entry observation.  Proxy TLS/connectivity can
                    # fail while the origin and tunnel are healthy; treating
                    # it as a confirmed formal outage would authorize the
                    # very tunnel restart that caused the observed outages.
                    # Explicit direct probes remain eligible for the existing
                    # continuous formal-down policy below.
                    if layer == 'formal-health' and row.get('proxyMode') == 'environment':
                        return None
                    # Auth/proxy denial, throttling, assets and missing passive
                    # samples never authorize connector recovery.
                    if row['reason'] == 'http-status' and not (row['httpStatus'] and row['httpStatus'] >= 500):
                        return None
                    if row['routeClass'] == 'proxy':
                        return None
                    return False
                return None
            def asset_value(row):
                if not row or row['outcome'] == 'unknown':
                    return None
                if row['outcome'] == 'ok' and row['reason'] == 'ok':
                    return True
                # Asset failures are entry degradation evidence only. They are
                # deliberately never fed into the formal tunnel-recovery
                # authority above.
                if row['outcome'] == 'failed' and row['reason'] in {
                        'http-status', 'http-auth', 'health-invalid', 'content-limit',
                        'empty-content', 'invalid-target', 'invalid-manifest'}:
                    return False
                return None
            asset_rows = [by_layer.get(layer) for layer in
                          ('login-html', 'viewer-html', 'core-asset') if by_layer.get(layer)]
            asset_value_result = None
            if asset_rows:
                self.state['assetsObserved'] = True
                values = [asset_value(row) for row in asset_rows]
                asset_value_result = False if False in values else True if all(value is True for value in values) else None
            observations = {'origin': health_value('origin-health'),
                            'formal': health_value('formal-health'),
                            'assets': asset_value_result}
            if not asset_rows:
                observations['assets'] = self.state.get('observations', {}).get('assets')
        self.state["observations"] = {key: observations.get(key) if type(observations.get(key)) is bool else None
                                      for key in ("origin", "formal", "assets")}
        self.state["action"] = "none"
        operation = self.state.get("operation")
        quarantine = self.state.get("quarantineUntil")
        if quarantine is not None and now >= quarantine:
            self.state["quarantinedCount"] = 0
            self.state["quarantineUntil"] = None
        self.state["recoveries"] = [t for t in self.state["recoveries"] if now - t < self.window_s]
        origin, formal = self.state["observations"]["origin"], self.state["observations"]["formal"]
        if origin is not True or formal is not False:
            self.state["failStartedAt"] = None
            if origin and formal:
                if self.state["observations"].get("assets") is False:
                    self.state["status"] = "entry-degraded"
                elif self.state.get("assetsObserved") and self.state["observations"].get("assets") is None:
                    self.state["status"] = "entry-unknown"
                elif self.state.get("slowLayers"):
                    self.state["status"] = "entry-slow"
                else:
                    self.state["status"] = "entry-healthy" if layered else "healthy"
            else:
                self.state["status"] = "origin-down" if origin is False else "unknown"
        else:
            if self.state["failStartedAt"] is None:
                self.state["failStartedAt"] = now
            self.state["status"] = "formal-down"
            if now - self.state["failStartedAt"] >= self.fail_s:
                cooldown = self.state.get("cooldownUntil")
                if operation and operation.get("state") in {"in-flight", "unknown"}:
                    self.state["status"] = "recovery-in-flight"
                elif self.state.get("quarantineUntil") is not None:
                    self.state["status"] = "clock-untrusted"
                elif cooldown is not None and now < cooldown:
                    self.state["status"] = "cooldown"
                elif len(self.state["recoveries"]) >= self.max_recoveries:
                    self.state["status"], self.state["action"] = "budget-exhausted", "notify"
                else:
                    self.state["action"] = "restart"
        return self.snapshot()

    @staticmethod
    def _percentile(values, fraction):
        if not values:
            return None
        ordered = sorted(values)
        index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1))
        return round(float(ordered[index]), 3)

    def _observe_latency(self, rows):
        history = self.state.setdefault("latencyHistory", {})
        modes = {row.get('proxyMode') for row in rows
                 if isinstance(row, dict) and row.get('proxyMode') in {'environment', 'direct'}}
        current_mode = next(iter(modes)) if len(modes) == 1 else 'mixed' if modes else None
        if current_mode is not None and current_mode != self.state.get('latencyMode'):
            # p95/p99 are meaningful only within one network vantage. Never
            # mix an environment proxy window with direct formal probes.
            history.clear()
            self.state['latencyMode'] = current_mode
        stats = {}
        slow_layers = []
        for row in rows:
            layer = row.get('layer') if isinstance(row, dict) else None
            elapsed = row.get('elapsedMs') if isinstance(row, dict) else None
            if layer not in LAYERS or type(elapsed) not in (int, float) or not math.isfinite(elapsed):
                continue
            values = history.get(layer)
            if not isinstance(values, list):
                values = []
            values = [value for value in values[-LATENCY_HISTORY_LIMIT + 1:]
                      if type(value) in (int, float) and math.isfinite(value) and value >= 0]
            values.append(round(float(elapsed), 3))
            history[layer] = values
            budget = self.latency_budgets_ms.get(layer)
            p50 = self._percentile(values, 0.50)
            p95 = self._percentile(values, 0.95)
            p99 = self._percentile(values, 0.99)
            maximum = round(max(values), 3) if values else None
            slow = bool(budget is not None and p95 is not None and p95 > float(budget))
            if slow:
                slow_layers.append(layer)
            stats[layer] = {
                'sampleCount': len(values), 'budgetMs': budget,
                'p50Ms': p50, 'p95Ms': p95, 'p99Ms': p99, 'maxMs': maximum,
                'slow': slow,
            }
        self.state['latency'] = stats
        self.state['slowLayers'] = sorted(set(slow_layers))

    def begin_recovery(self, operation_id, *, worker_pid=None, worker_start=None):
        if not isinstance(operation_id, str) or not operation_id or len(operation_id) > 128:
            raise ValueError("bounded operation identity required")
        if self.state.get("action") != "restart":
            return False
        current = self.state.get("operation")
        if current and current.get("state") in {"in-flight", "unknown"}:
            return False
        self.state["operation"] = {"id": operation_id, "state": "in-flight",
                                   "startedMono": self.state["lastMono"], "workerPid": worker_pid,
                                   "workerStart": worker_start, "finishedMono": None, "outcome": None}
        self.state["recoveries"].append(self.state["lastMono"])
        self.state["action"] = "none"
        return True

    def reconcile_worker(self, pid, start_identity, *, alive):
        operation = self.state.get("operation")
        if not operation or operation.get("state") == "terminal":
            return False
        matching = (pid == operation.get("workerPid") and start_identity
                    and start_identity == operation.get("workerStart"))
        # Absence alone does not prove a worker's mutating children terminated.
        operation["state"] = "in-flight" if matching and alive is True else "unknown"
        return bool(matching and alive is True)

    def complete_recovery(self, operation_id, finished_mono, outcome, *, terminated=False):
        operation = self.state.get("operation")
        if not operation or operation.get("id") != operation_id or operation.get("state") == "terminal":
            return False
        if terminated is not True:
            operation["state"] = "unknown"
            return False
        finished = self._time(finished_mono)
        if finished < operation["startedMono"] or outcome not in {"ok", "failed", "timeout", "cancelled"}:
            operation["state"] = "unknown"
            return False
        operation.update(state="terminal", finishedMono=finished, outcome=outcome)
        self.state["cooldownUntil"] = finished + self.cooldown_s
        return True

    def snapshot(self):
        return copy.deepcopy(self.state)
