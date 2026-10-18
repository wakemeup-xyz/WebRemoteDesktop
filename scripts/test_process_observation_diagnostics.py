"""Pure injected tests; the small base below is not the immutable Registry."""
import importlib.util
import json
import pathlib
import unittest

from process_observation_diagnostics import Diagnostics, instrument_registry


CANARY = "SECRET password=canary argv=/private/token clipboard=canary"
MAX_INT = 2147483647


class Gone(Exception):
    pass


class Denied(Exception):
    pass


class SystemFailure(Exception):
    pass


SUPPORTED = (Gone, Denied, SystemFailure)


class Process:
    def __init__(self, trace, pid=7, birth=12.5):
        self.trace = trace
        self.number = pid
        self.birth = birth
        self.failures = {}
        self.child_values = []

    def call(self, operation, value, *args):
        self.trace.append((operation, args))
        if operation in self.failures:
            raise self.failures[operation]
        return value

    @property
    def pid(self):
        return self.call("pid", self.number)

    def create_time(self):
        return self.call("create_time", self.birth)

    def status(self):
        return self.call("status", "running")

    def children(self, recursive=False):
        return self.call("children", self.child_values, recursive)

    def ppid(self):
        return self.call("ppid", 7)

    def terminate(self):
        return self.call("terminate", "terminated")

    def kill(self):
        return self.call("kill", "killed")


class DelegatingBase:
    """Dispatch callbacks only: no copied Registry business logic."""
    def __init__(self, process):
        self.process = process
        self.calls = []
        self.on_state = lambda pid: ("state", pid)
        self.on_scan = lambda: "scanned"
        self.on_signal = lambda kind: ("signal", kind)
        self.on_note = lambda reason: ("note", reason)

    def state(self, pid):
        self.calls.append(("state", pid))
        return self.on_state(pid)

    def scan(self):
        self.calls.append(("scan",))
        return self.on_scan()

    def signal(self, kind):
        self.calls.append(("signal", kind))
        return self.on_signal(kind)

    def note(self, reason):
        self.calls.append(("note", reason))
        return self.on_note(reason)


class DiagnosticsTests(unittest.TestCase):
    def make(self, factory=None, **kwargs):
        self.trace = []
        self.raw = Process(self.trace)
        self.factory_calls = []

        def default_factory(pid):
            self.factory_calls.append(pid)
            return self.raw

        diagnostic = Diagnostics(factory or default_factory, SUPPORTED, "worker",
                                 monotonic=kwargs.pop("monotonic", lambda: 10.25),
                                 wall=kwargs.pop("wall", lambda: 20.5), **kwargs)
        return diagnostic, instrument_registry(DelegatingBase, diagnostic)

    def failing_factory(self, error):
        def factory(pid):
            raise error
        return factory

    def observe_error(self, diagnostic, error, context="scan", pid=7):
        diagnostic._factory = self.failing_factory(error)
        with diagnostic.context(context, pid=pid):
            with self.assertRaises(type(error)) as caught:
                diagnostic.process(pid)
            self.assertIs(caught.exception, error)

    def test_import_and_construction_are_inert(self):
        module_path = pathlib.Path(__file__).with_name("process_observation_diagnostics.py")
        spec = importlib.util.spec_from_file_location("isolated_diagnostics", module_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        calls = []
        diagnostic = module.Diagnostics(lambda pid: calls.append(pid), SUPPORTED, "sample",
                                        monotonic=lambda: calls.append("clock"),
                                        wall=lambda: calls.append("clock"))
        module.instrument_registry(DelegatingBase, diagnostic)
        self.assertEqual(calls, [])

    def test_all_wrappers_delegate_exactly_once_and_preserve_returns(self):
        diagnostic, registry = self.make()
        marker = object()
        registry.on_state = lambda pid: marker
        registry.on_scan = lambda: marker
        registry.on_signal = lambda kind: marker
        registry.on_note = lambda reason: marker
        self.assertIs(registry.state(7), marker)
        self.assertIs(registry.scan(), marker)
        self.assertIs(registry.signal("term"), marker)
        self.assertIs(registry.note("identity-capacity"), marker)
        self.assertEqual(registry.calls, [("state", 7), ("scan",),
                                         ("signal", "term"), ("note", "identity-capacity")])
        self.assertEqual(self.factory_calls, [])
        self.assertEqual(self.trace, [])
        self.assertFalse(diagnostic.failed)

    def test_wrappers_preserve_business_exceptions_by_identity(self):
        diagnostic, registry = self.make()
        error = RuntimeError(CANARY)
        def fail(*args):
            raise error
        for name, args in (("state", (7,)), ("scan", ()),
                           ("signal", ("kill",)), ("note", ("identity-capacity",))):
            setattr(registry, "on_" + name, fail)
            with self.assertRaises(RuntimeError) as caught:
                getattr(registry, name)(*args)
            self.assertIs(caught.exception, error)
        self.assertEqual(len(registry.calls), 4)
        self.assertEqual(diagnostic.snapshot()["events"], [])

    def test_exact_proxy_trace_and_no_eager_pid_read(self):
        diagnostic, _ = self.make()
        proxy = diagnostic.process(7)
        self.assertEqual(self.factory_calls, [7])
        self.assertEqual(self.trace, [])
        self.assertEqual(proxy.create_time(), 12.5)
        self.assertEqual(proxy.status(), "running")
        self.assertEqual(proxy.children(recursive=False), [])
        self.assertEqual(proxy.ppid(), 7)
        self.assertEqual(proxy.terminate(), "terminated")
        self.assertEqual(proxy.kill(), "killed")
        self.assertEqual(proxy.pid, 7)
        self.assertEqual(self.trace, [("create_time", ()), ("status", ()),
                                     ("children", (False,)), ("ppid", ()),
                                     ("terminate", ()), ("kill", ()), ("pid", ())])

    def test_proxy_supported_exception_identity_for_every_operation(self):
        for operation in ("pid", "create_time", "status", "children", "ppid", "terminate", "kill"):
            for cls in SUPPORTED:
                with self.subTest(operation=operation, error=cls):
                    diagnostic, _ = self.make()
                    error = cls(CANARY)
                    error.errno = 13
                    self.raw.failures[operation] = error
                    proxy = diagnostic.process(7)
                    with self.assertRaises(cls) as caught:
                        if operation == "pid":
                            proxy.pid
                        else:
                            getattr(proxy, operation)()
                    self.assertIs(caught.exception, error)
                    event = diagnostic.snapshot()["events"][0]
                    self.assertEqual(event["operation"], operation)
                    self.assertEqual(event["errno"], 13)
                    self.assertNotIn(CANARY, json.dumps(diagnostic.snapshot()))

    def test_factory_supported_exception_identity_and_ordered_isinstance(self):
        class Both(Gone, Denied):
            pass
        error = Both(CANARY)
        diagnostic, _ = self.make(self.failing_factory(error))
        with self.assertRaises(Both) as caught:
            diagnostic.process(7)
        self.assertIs(caught.exception, error)
        self.assertEqual(diagnostic.snapshot()["events"][0]["exception"], "NoSuchProcess")

    def test_exception_name_does_not_imply_supported_class(self):
        impostor = type("Gone", (Exception,), {})(CANARY)
        diagnostic, _ = self.make(self.failing_factory(impostor))
        with diagnostic.context("state", pid=7):
            with self.assertRaises(type(impostor)) as caught:
                diagnostic.process(7)
        self.assertIs(caught.exception, impostor)
        self.assertEqual(sum(diagnostic.snapshot()["expectedStateExitCounts"].values()), 0)

    def test_expected_exit_flood_does_not_displace_scan_gap(self):
        error = Gone(CANARY)
        diagnostic, registry = self.make(self.failing_factory(error))
        def state(pid):
            try:
                registry.process(pid)
            except Gone:
                return "exited"
        registry.on_state = state
        for _ in range(40):
            self.assertEqual(registry.state(7), "exited")
        def scan():
            try:
                registry.process(7)
            except Gone:
                registry.note("observation-unavailable")
        registry.on_scan = scan
        registry.scan()
        snapshot = diagnostic.snapshot()
        self.assertEqual(snapshot["expectedStateExitCounts"],
                         {"worker-loop": 40, "cleanup": 0, "result": 0})
        self.assertEqual(len(snapshot["events"]), 1)
        self.assertEqual(snapshot["events"][-1]["context"], "scan")
        self.assertEqual(snapshot["gaps"][-1]["eventId"], snapshot["events"][-1]["eventId"])
        self.assertEqual(snapshot["gaps"][-1]["scanId"], snapshot["events"][-1]["scanId"])
        self.assertEqual(snapshot["gaps"][-1]["association"], "direct-scan-error")
        self.assertFalse(snapshot["failed"])

    def test_fixed_stage_counters_and_signal_errors(self):
        diagnostic, registry = self.make(self.failing_factory(Gone(CANARY)))
        registry.on_state = lambda pid: registry.process(pid)
        registry.on_signal = lambda kind: registry.process(7)
        for stage in ("worker-loop", "cleanup", "result"):
            diagnostic.set_stage(stage)
            with self.assertRaises(Gone):
                registry.state(7)
        with self.assertRaises(Gone):
            registry.signal("term")
        snapshot = diagnostic.snapshot()
        self.assertEqual(list(snapshot["expectedStateExitCounts"].values()), [1, 1, 1])
        self.assertEqual(snapshot["events"][0]["context"], "signal")
        self.assertEqual(snapshot["events"][0]["stage"], "result")

    def test_non_exit_state_errors_retain_events(self):
        diagnostic, _ = self.make()
        for error in (Denied(CANARY), SystemFailure(CANARY)):
            self.observe_error(diagnostic, error, "state")
        self.assertEqual([e["context"] for e in diagnostic.snapshot()["events"]], ["state", "state"])

    def test_nested_state_cannot_create_or_overwrite_scan_token(self):
        diagnostic, registry = self.make(self.failing_factory(Denied(CANARY)))
        registry.on_state = lambda pid: registry.process(pid)
        def scan():
            try:
                registry.process(7)
            except Denied:
                pass
            try:
                registry.state(8)
            except Denied:
                pass
            registry.note("observation-unavailable")
        registry.on_scan = scan
        registry.scan()
        snapshot = diagnostic.snapshot()
        self.assertEqual([e["context"] for e in snapshot["events"]], ["scan", "state"])
        self.assertEqual(snapshot["gaps"][0]["eventId"], snapshot["events"][0]["eventId"])
        registry.on_scan = lambda: self.nested_state_gap(registry)
        registry.scan()
        self.assertIsNone(diagnostic.snapshot()["gaps"][-1]["eventId"])

    def nested_state_gap(self, registry):
        try:
            registry.state(8)
        except Denied:
            pass
        registry.note("observation-unavailable")

    def test_pending_token_is_consumed_once_and_cleared_between_scans(self):
        diagnostic, registry = self.make(self.failing_factory(Denied(CANARY)))
        def scan():
            try:
                registry.process(7)
            except Denied:
                pass
            registry.note("parent-chain-changed")
            registry.note("observation-unavailable")
            registry.note("observation-unavailable")
        registry.on_scan = scan
        registry.scan()
        registry.on_scan = lambda: registry.note("observation-unavailable")
        registry.scan()
        registry.note("observation-unavailable")
        gaps = diagnostic.snapshot()["gaps"]
        self.assertEqual([g["eventId"] for g in gaps], [1, None, None, None])
        self.assertEqual([g["association"] for g in gaps],
                         ["direct-scan-error", "unassociated", "unassociated", "unassociated"])
        self.assertEqual([g["scanId"] for g in gaps], [1, 1, 2, None])

    def test_nested_scan_restores_outer_pending_token(self):
        diagnostic, registry = self.make(self.failing_factory(Denied(CANARY)))
        nesting = []
        def scan():
            if not nesting:
                nesting.append(True)
                try:
                    registry.process(7)
                except Denied:
                    pass
                registry.scan()
            registry.note("observation-unavailable")
        registry.on_scan = scan
        registry.scan()
        gaps = diagnostic.snapshot()["gaps"]
        self.assertEqual([(g["scanId"], g["eventId"]) for g in gaps], [(2, None), (1, 1)])

    def test_context_restoration_after_business_exception(self):
        diagnostic, registry = self.make(self.failing_factory(Denied(CANARY)))
        registry.on_scan = lambda: registry.process(7)
        with self.assertRaises(Denied):
            registry.scan()
        with self.assertRaises(Denied):
            diagnostic.process(8)
        self.assertEqual([e["context"] for e in diagnostic.snapshot()["events"]], ["scan", "outside"])
        registry.note("observation-unavailable")
        self.assertIsNone(diagnostic.snapshot()["gaps"][0]["eventId"])

    def test_child_identity_is_unknown_until_reads_and_cached_birth_is_separate(self):
        diagnostic, registry = self.make()
        child_trace = []
        child = Process(child_trace, pid=8, birth=15.0)
        error = Denied(CANARY)
        child.failures["create_time"] = error
        self.raw.child_values = [child]
        with diagnostic.context("scan", registry=registry):
            proxy = diagnostic.process(7).children(recursive=False)[0]
            self.assertEqual(child_trace, [])
            with self.assertRaises(Denied):
                proxy.create_time()
            del child.failures["create_time"]
            self.assertEqual(proxy.create_time(), 15.0)
            child.failures["status"] = error
            with self.assertRaises(Denied):
                proxy.status()
            self.assertEqual(proxy.pid, 8)
            with self.assertRaises(Denied):
                proxy.status()
        events = diagnostic.snapshot()["events"]
        self.assertEqual([(e["pid"], e["birth"]) for e in events],
                         [(None, None), (None, 15.0), (8, 15.0)])
        self.assertEqual(child_trace, [("create_time", ()), ("create_time", ()),
                                       ("status", ()), ("pid", ()), ("status", ())])

    def test_same_pid_incarnations_keep_distinct_observed_births(self):
        diagnostic, _ = self.make()
        for birth in (12.0, 13.0):
            self.raw.birth = birth
            proxy = diagnostic.process(7)
            proxy.create_time()
            self.raw.failures["status"] = Denied(CANARY)
            with self.assertRaises(Denied):
                proxy.status()
        self.assertEqual([e["birth"] for e in diagnostic.snapshot()["events"]], [12.0, 13.0])

    def test_invalid_clocks_and_metadata_are_null_and_failure_is_sticky(self):
        diagnostic, _ = self.make(monotonic=lambda: float("nan"), wall=lambda: CANARY)
        self.observe_error(diagnostic, Denied(CANARY), pid=CANARY)
        event = diagnostic.snapshot()["events"][0]
        self.assertIsNone(event["pid"])
        self.assertIsNone(event["monotonic"])
        self.assertIsNone(event["wall"])
        self.assertTrue(diagnostic.failed)
        diagnostic.set_stage("result")
        self.assertTrue(diagnostic.failed)
        self.assertNotIn(CANARY, json.dumps(diagnostic.snapshot(), allow_nan=False))

    def test_clock_exceptions_do_not_replace_process_exception(self):
        error = Denied(CANARY)
        def clock():
            raise RuntimeError(CANARY)
        diagnostic, _ = self.make(self.failing_factory(error), monotonic=clock, wall=clock)
        with self.assertRaises(Denied) as caught:
            diagnostic.process(7)
        self.assertIs(caught.exception, error)
        self.assertTrue(diagnostic.failed)

    def test_invalid_birth_errno_role_stage_context_and_reason_are_not_persisted(self):
        diagnostic, registry = self.make()
        self.raw.birth = CANARY
        error = Denied(CANARY)
        error.errno = CANARY
        self.raw.failures["status"] = error
        proxy = diagnostic.process(7)
        self.assertEqual(proxy.create_time(), CANARY)
        with self.assertRaises(Denied):
            proxy.status()
        diagnostic.set_stage(CANARY)
        with diagnostic.context(CANARY, pid=7):
            with self.assertRaises(Denied):
                proxy.status()
        registry.note(CANARY)
        snapshot = diagnostic.snapshot()
        self.assertTrue(snapshot["failed"])
        self.assertIsNone(snapshot["events"][0]["birth"])
        self.assertIsNone(snapshot["events"][0]["errno"])
        self.assertEqual(registry.calls[-1], ("note", CANARY))
        self.assertNotIn(CANARY, json.dumps(snapshot))
        invalid = Diagnostics(lambda pid: None, SUPPORTED, CANARY,
                              monotonic=lambda: 1, wall=lambda: 1)
        self.assertTrue(invalid.failed)
        self.assertNotIn(CANARY, json.dumps(invalid.snapshot()))

    def test_recorder_failure_preserves_process_exception_and_context(self):
        diagnostic, registry = self.make(self.failing_factory(Denied(CANARY)))
        def broken(*args, **kwargs):
            raise RuntimeError(CANARY)
        diagnostic._record_error = broken
        registry.on_state = lambda pid: registry.process(pid)
        with self.assertRaises(Denied):
            registry.state(7)
        self.assertTrue(diagnostic.failed)
        self.assertEqual(diagnostic._contexts, [])

    def test_bounded_pools_overflow_and_lost_gap_event_veto(self):
        diagnostic, registry = self.make(self.failing_factory(Denied(CANARY)))
        def scan():
            try:
                registry.process(7)
            except Denied:
                pass
            registry.note("observation-unavailable")
        registry.on_scan = scan
        for _ in range(40):
            registry.scan()
        snapshot = diagnostic.snapshot()
        self.assertEqual(len(snapshot["events"]), 32)
        self.assertEqual(len(snapshot["gaps"]), 32)
        self.assertEqual(snapshot["dropped"], 8)
        self.assertEqual(snapshot["gapsDropped"], 8)
        self.assertTrue(snapshot["overflow"]["events"])
        self.assertTrue(snapshot["overflow"]["gaps"])
        self.assertTrue(snapshot["failed"])
        self.assertLess(len(json.dumps(snapshot, allow_nan=False).encode()), 32768)

    def test_lost_scan_event_never_links_previous_retained_event(self):
        diagnostic, registry = self.make(self.failing_factory(Denied(CANARY)), limit=1)
        def scan():
            for _ in range(2):
                try:
                    registry.process(7)
                except Denied:
                    pass
            registry.note("observation-unavailable")
        registry.on_scan = scan
        registry.scan()
        snapshot = diagnostic.snapshot()
        self.assertIsNone(snapshot["gaps"][0]["eventId"])
        self.assertEqual(snapshot["gaps"][0]["association"], "unassociated")
        self.assertTrue(snapshot["failed"])

    def test_counter_saturation_is_visible(self):
        diagnostic, _ = self.make()
        diagnostic._expected["worker-loop"] = MAX_INT
        self.observe_error(diagnostic, Gone(CANARY), "state")
        diagnostic._scan_seq = MAX_INT
        with diagnostic.context("scan"):
            pass
        diagnostic._event_seq = MAX_INT
        self.observe_error(diagnostic, Denied(CANARY), "signal")
        diagnostic._dropped = MAX_INT
        diagnostic._events = [None] * 32
        self.observe_error(diagnostic, Denied(CANARY))
        snapshot = diagnostic.snapshot()
        self.assertEqual(snapshot["expectedStateExitCounts"]["worker-loop"], MAX_INT)
        self.assertEqual(snapshot["dropped"], MAX_INT)
        self.assertTrue(snapshot["overflow"]["counters"])
        self.assertTrue(snapshot["failed"])

    def test_context_depth_is_bounded_and_overflow_never_inherits_state(self):
        diagnostic, _ = self.make(self.failing_factory(Gone(CANARY)))
        def nested(depth):
            with diagnostic.context("state", pid=7):
                self.assertLessEqual(len(diagnostic._contexts), 8)
                if depth:
                    nested(depth - 1)
                else:
                    with self.assertRaises(Gone):
                        diagnostic.process(7)
        nested(9)
        snapshot = diagnostic.snapshot()
        self.assertEqual(sum(snapshot["expectedStateExitCounts"].values()), 0)
        self.assertEqual(snapshot["events"][0]["context"], "outside")
        self.assertTrue(snapshot["overflow"]["contexts"])
        self.assertTrue(snapshot["failed"])
        self.assertEqual(diagnostic._contexts, [])

    def test_snapshot_is_detached_json_safe_and_scope_is_explicit(self):
        diagnostic, registry = self.make(self.failing_factory(Denied(CANARY)))
        self.observe_error(diagnostic, Denied(CANARY))
        registry.note("observation-unavailable")
        snapshot = diagnostic.snapshot()
        self.assertEqual(snapshot["schemaVersion"], 2)
        self.assertEqual(snapshot["scope"], "diagnostic-only")
        self.assertEqual(snapshot["limits"], {"events": 32, "gaps": 32,
                                              "contextDepth": 8, "counter": MAX_INT})
        snapshot["events"][0]["pid"] = CANARY
        snapshot["gaps"][0]["association"] = CANARY
        snapshot["expectedStateExitCounts"]["worker-loop"] = 99
        self.assertNotIn(CANARY, json.dumps(diagnostic.snapshot(), allow_nan=False))
        self.assertEqual(diagnostic.snapshot()["expectedStateExitCounts"]["worker-loop"], 0)


if __name__ == "__main__":
    unittest.main()
