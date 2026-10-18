"""Bounded, injected diagnostics; this module grants no process authority.

The wrapper adds explicit call context to an unchanged injected Registry. Process
objects are observed only when its caller requests one of the supported reads.
There are no process, filesystem, network, or clock observations at import or
construction. The caller must continue to reject ``failed`` diagnostics.
"""
from contextlib import contextmanager
from copy import deepcopy
import math


_MAX_INT = 2147483647
_MAX_DEPTH = 8
_STAGES = ("worker-loop", "cleanup", "result")
_CONTEXTS = ("state", "scan", "signal")
_REASONS = ("observation-unavailable", "observed-pid-reuse",
            "parent-chain-unavailable", "parent-chain-changed",
            "signal-skipped-reused", "signal-skipped-unknown", "identity-capacity")
_EXCEPTIONS = ("NoSuchProcess", "AccessDenied", "OSError")


class Diagnostics:
    """Record only bounded, sanitized metadata from already requested calls.

    ``supported`` is ordered (NoSuchProcess, AccessDenied, OSError); subclasses
    are classified by the first matching injected class, never by their names.
    ``limit`` may reduce each pool below 32 for a stricter consumer.
    """
    def __init__(self, factory, supported, role, *, monotonic, wall, limit=32):
        self._failed = False
        self._overflow = dict.fromkeys(("events", "gaps", "contexts", "counters"), False)
        self._factory = factory
        self._monotonic = monotonic
        self._wall = wall
        self._supported = ()
        try:
            if (type(supported) is tuple and len(supported) == 3
                    and all(isinstance(cls, type) and issubclass(cls, BaseException)
                            for cls in supported)):
                self._supported = supported
            else:
                self._failed = True
        except BaseException:
            self._failed = True
        self._role = role if type(role) is str and role in ("worker", "sample") else None
        if self._role is None:
            self._failed = True
        if type(limit) is int and 1 <= limit <= 32:
            self._limit = limit
        else:
            self._limit = 32
            self._failed = True
        if not all(callable(value) for value in (factory, monotonic, wall)):
            self._failed = True
        self._stage = "worker-loop"
        self._contexts = []
        self._context_disabled = False
        self._expected = dict.fromkeys(_STAGES, 0)
        self._events = []
        self._gaps = []
        self._recording = False
        self._dropped = 0
        self._gaps_dropped = 0
        self._event_seq = 0
        self._scan_seq = 0

    @property
    def failed(self):
        """Sticky diagnostic failure, independent of the Registry's decisions."""
        return self._failed

    def set_stage(self, stage):
        if type(stage) is str and stage in _STAGES:
            self._stage = stage
        else:
            self._failed = True

    def _increment(self, value):
        if value >= _MAX_INT:
            self._overflow["counters"] = True
            self._failed = True
            return _MAX_INT
        return value + 1

    def _sequence(self, attribute):
        value = getattr(self, attribute)
        if value >= _MAX_INT:
            self._increment(value)
            return None  # A reused saturated ID could create a false association.
        value = self._increment(value)
        setattr(self, attribute, value)
        return value

    def _number(self, value, *, pid=False, integer=False):
        if value is None:
            return None
        valid = type(value) is int if (pid or integer) else type(value) in (int, float)
        if valid:
            try:
                valid = math.isfinite(value)
                if pid:
                    valid = valid and 0 < value <= _MAX_INT
                elif integer:
                    valid = valid and -_MAX_INT <= value <= _MAX_INT
                else:
                    valid = valid and value >= 0
            except (OverflowError, ValueError):
                valid = False
        if not valid:
            self._failed = True
            return None
        return value

    def _clock(self, clock):
        try:
            value = clock()
            if value is None:
                self._failed = True
            return self._number(value)
        except BaseException:
            self._failed = True
            return None

    def _frame(self):
        if self._context_disabled or not self._contexts:
            return None
        return self._contexts[-1]

    @contextmanager
    def context(self, name, *, registry=None, pid=None):
        """Restore context in finally; ``registry`` never triggers object reads.

        A scan owns its own pending token. A nested state (or nested scan) has
        no access to the outer scan's token. Overflow disables attribution for
        that scope, preventing accidental inheritance of an expected state exit.
        """
        frame = None
        was_disabled = self._context_disabled
        try:
            if type(name) is not str or name not in _CONTEXTS:
                self._failed = True
                self._context_disabled = True
            elif was_disabled:
                self._context_disabled = True
            elif len(self._contexts) >= _MAX_DEPTH:
                self._overflow["contexts"] = True
                self._failed = True
                self._context_disabled = True
            else:
                scan_id = None
                if name == "scan":
                    scan_id = self._sequence("_scan_seq")
                else:
                    for outer in reversed(self._contexts):
                        if outer["name"] == "scan":
                            scan_id = outer["scanId"]
                            break
                frame = {"name": name, "pid": self._number(pid, pid=True),
                         "scanId": scan_id, "pending": None}
                self._contexts.append(frame)
        except BaseException:
            self._failed = True
            self._context_disabled = True
        try:
            yield
        finally:
            try:
                if frame is not None:
                    if self._contexts and self._contexts[-1] is frame:
                        self._contexts.pop()
                    else:
                        self._failed = True
                        self._contexts.clear()
            except BaseException:
                self._failed = True
            self._context_disabled = was_disabled

    def _safe_error(self, error, operation, pid, birth):
        try:
            frame = self._frame()
            if frame is not None and frame["name"] == "scan":
                frame["pending"] = None
            self._record_error(error, operation, pid, birth)
        except BaseException:
            self._failed = True

    def _record_error(self, error, operation, pid, birth):
        classification = None
        for cls, label in zip(self._supported, _EXCEPTIONS):
            if isinstance(error, cls):
                classification = label
                break
        if classification is None:
            # Unsupported errors still propagate unchanged, but are not claimed
            # to have complete diagnostic classification.
            self._failed = True
            classification = "Unsupported"
        frame = self._frame()
        if frame is not None and frame["name"] == "state" and classification == "NoSuchProcess":
            self._expected[self._stage] = self._increment(self._expected[self._stage])
            return
        if frame is not None and frame["name"] == "scan":
            # Invalidate the previous token even if this newer event is dropped.
            frame["pending"] = None
        if len(self._events) >= self._limit:
            self._dropped = self._increment(self._dropped)
            self._overflow["events"] = True
            self._failed = True
            return
        event_id = self._sequence("_event_seq")
        event = {"eventId": event_id, "scanId": frame["scanId"] if frame else None,
                 "role": self._role, "stage": self._stage,
                 "context": frame["name"] if frame else "outside",
                 "operation": operation, "pid": self._number(pid, pid=True),
                 "birth": self._number(birth), "exception": classification,
                 "errno": None, "monotonic": None, "wall": None}
        # Reserve capacity and the pending token before any external callback.
        # Nested errors may invalidate/replace that token; never reset it after
        # the callbacks return, even when this outer event completes last.
        self._events.append(event)
        if (frame is not None and frame["name"] == "scan"
                and frame["scanId"] is not None and event_id is not None):
            frame["pending"] = event_id
        was_recording = self._recording
        self._recording = True
        try:
            try:
                event["errno"] = self._number(getattr(error, "errno", None), integer=True)
            except BaseException:
                self._failed = True
            event["monotonic"] = self._clock(self._monotonic)
            event["wall"] = self._clock(self._wall)
        finally:
            self._recording = was_recording

    def process(self, pid):
        try:
            target = self._factory(pid)
        except BaseException as error:
            self._safe_error(error, "resolve", pid, None)
            raise
        return _ProcessProxy(target, self, self._number(pid, pid=True))

    def _note(self, reason):
        """Called after the unchanged Registry note has successfully returned."""
        try:
            if type(reason) is not str or reason not in _REASONS:
                self._failed = True
                return
            if reason != "observation-unavailable":
                return
            frame = self._frame()
            event_id = None
            scan_id = frame["scanId"] if frame else None
            if frame is not None and frame["name"] == "scan":
                event_id = frame["pending"]
                frame["pending"] = None
            if len(self._gaps) >= self._limit:
                self._gaps_dropped = self._increment(self._gaps_dropped)
                self._overflow["gaps"] = True
                self._failed = True
                return
            gap = {"scanId": scan_id, "eventId": event_id,
                   "association": "direct-scan-error" if event_id is not None else "unassociated",
                   "reason": "observation-unavailable", "role": self._role,
                   "stage": self._stage, "monotonic": None, "wall": None}
            self._gaps.append(gap)
            was_recording = self._recording
            self._recording = True
            try:
                gap["monotonic"] = self._clock(self._monotonic)
                gap["wall"] = self._clock(self._wall)
            finally:
                self._recording = was_recording
        except BaseException:
            self._failed = True

    def snapshot(self):
        """Return detached JSON-safe evidence; this is never an acceptance gate."""
        if self._recording:
            # A callback may request a snapshot before the reserved record's
            # clocks finish. Its nullable shape is safe, but not complete.
            self._failed = True
        return deepcopy({"schemaVersion": 2, "scope": "diagnostic-only", "role": self._role,
                         "events": self._events, "dropped": self._dropped, "failed": self._failed,
                         "expectedStateExitCounts": self._expected, "gaps": self._gaps,
                         "gapsDropped": self._gaps_dropped, "overflow": self._overflow,
                         "limits": {"events": self._limit, "gaps": self._limit,
                                    "contextDepth": _MAX_DEPTH, "counter": _MAX_INT}})


class _ProcessProxy:
    """No attribute forwarding: every supported operation delegates once."""
    def __init__(self, target, diagnostic, pid=None):
        self._target = target
        self._diagnostic = diagnostic
        self._pid = pid
        self._birth = None

    def _invoke(self, operation, call):
        try:
            result = call()
        except BaseException as error:
            self._diagnostic._safe_error(error, operation, self._pid, self._birth)
            raise
        try:
            if operation == "pid":
                self._pid = self._diagnostic._number(result, pid=True)
            elif operation == "create_time":
                self._birth = self._diagnostic._number(result)
        except BaseException:
            self._diagnostic._failed = True
        return result

    @property
    def pid(self):
        return self._invoke("pid", lambda: self._target.pid)

    def create_time(self):
        return self._invoke("create_time", lambda: self._target.create_time())

    def status(self):
        return self._invoke("status", lambda: self._target.status())

    def children(self, recursive=False):
        children = self._invoke("children", lambda: self._target.children(recursive=recursive))
        return [_ProcessProxy(child, self._diagnostic) for child in children]

    def ppid(self):
        return self._invoke("ppid", lambda: self._target.ppid())

    def terminate(self):
        return self._invoke("terminate", lambda: self._target.terminate())

    def kill(self):
        return self._invoke("kill", lambda: self._target.kill())


def instrument_registry(registry_type, diagnostic):
    """Instantiate an injected subclass; inherited initialization stays intact."""
    class ContextualRegistry(registry_type):
        def state(self, pid):
            with diagnostic.context("state", registry=self, pid=pid):
                return super().state(pid)

        def scan(self):
            with diagnostic.context("scan", registry=self):
                return super().scan()

        def signal(self, kind):
            with diagnostic.context("signal", registry=self):
                return super().signal(kind)

        def note(self, reason):
            result = super().note(reason)
            try:
                diagnostic._note(reason)
            except BaseException:
                diagnostic._failed = True
            return result

    return ContextualRegistry(process=diagnostic.process)
