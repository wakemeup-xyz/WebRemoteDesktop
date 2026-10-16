"""Same-clock adapter timing; importing this module performs no native work."""
import math
import time
from input_admission_queue import input_queued_ns

class InputTiming:
    def __init__(self, clock_ns=time.perf_counter_ns):
        self.clock_ns = clock_ns
        self.queued_ns = input_queued_ns.get()
        if self.queued_ns is None:
            self.queued_ns = clock_ns()
        self.started_ns = self.finished_ns = None

    def start_apply(self):
        if self.started_ns is None:
            self.started_ns = self.clock_ns()

    def finish_apply(self):
        if self.started_ns is not None and self.finished_ns is None:
            self.finished_ns = self.clock_ns()

    def durations(self):
        def delta(a, b):
            return (b - a) / 1_000_000 if a is not None and b is not None and b >= a else None
        return {"hostQueueMs": delta(self.queued_ns, self.started_ns),
                "hostApplyMs": delta(self.started_ns, self.finished_ns)}


def relay_ack_duration_ms(sent_at_ms, received_at_ms):
    if type(sent_at_ms) not in (int, float) or type(received_at_ms) not in (int, float):
        return None
    return received_at_ms - sent_at_ms if math.isfinite(sent_at_ms) and math.isfinite(received_at_ms) and received_at_ms >= sent_at_ms else None
