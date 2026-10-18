"""Pure capture-cycle evidence, published by one capture worker on CPython/GIL.

Intervals close at the *next* start. Completion buckets can include an interval
whose start precedes the window. Rate is active interval count / covered time,
not fresh-content FPS or input latency. No free-threaded publication guarantee.
"""
from typing import NamedTuple

COUNT_CAP = 999_999_999
DURATION_CAP_NS = 3_600_000_000_000
SECOND_NS = 1_000_000_000
SCOPE = 'rolling-60s-completion-buckets'
STAGES = ('interval', 'grab', 'postGrab', 'pacingActual', 'other', 'minInterval',
          'pacingRequested', 'pacingExcess', 'publishLockWait', 'publishCritical')
COUNTERS = ('published', 'discarded', 'error', 'discontinuous', 'invalidTiming')
PHASES = frozenset(('activity-gate', 'target-config', 'grab', 'publish',
    'post-publish', 'pacing', 'suspended', 'error', 'stopped', 'unavailable'))
REASONS = frozenset(('startup', 'suspended', 'profile-change', 'error', 'stopped',
                    'publish-error', 'invalid-clock', 'discarded'))


def _scalar(value):
    return value if type(value) is int and value >= 0 else None


def _bounded(value):
    value = _scalar(value)
    return value if value is not None and value <= DURATION_CAP_NS else None


def _generation(value):
    value = _scalar(value)
    return value if value is not None and value <= COUNT_CAP else None


def _ms(value):
    return None if value is None else min(value, DURATION_CAP_NS) / 1_000_000


class _Stage(NamedTuple):
    count: int = 0
    total: int = 0
    maximum: int | None = None
    clipped: bool = False


class _Bucket(NamedTuple):
    second: int
    stages: tuple = (_Stage(),) * len(STAGES)
    counters: tuple = (0,) * len(COUNTERS)
    last: tuple | None = None
    maximum: tuple | None = None
    clipped: bool = False


class _Cycle(NamedTuple):
    start: int | None
    capture: int | None
    target: int | None
    minimum: int | None
    finish: tuple | None = None


class _Publication(NamedTuple):
    history: tuple = ()
    current: _Bucket | None = None
    pending: _Cycle | None = None
    phase: str = 'unavailable'
    phase_ns: int | None = None
    now_ns: int | None = None
    state: str = 'starting'
    clipped: bool = False


def _pair(values):
    return None if values is None else {name + 'Ms': _ms(value) for name, value in zip(STAGES, values)}


def unavailable_capture_cadence():
    return dict(scope=SCOPE, state='unavailable', phase='unavailable', phaseAgeMs=None,
        intervalCount=None, activeIntervalCoveredMs=None, activeIntervalRateHz=None,
        lastInterval=None, maxInterval=None,
        stages={name: dict(count=None, sumMs=None, meanMs=None, maxMs=None) for name in STAGES},
        **{name: None for name in COUNTERS}, clipped=False)


class CaptureCadenceObserver:
    """Single writer; one immutable publication read, at most 60 buckets.

    Intra-second updates replace only the current aggregate. History changes
    only on second boundaries; even a huge clock jump does bounded work.
    Snapshot allocates fresh output dictionaries and acquires no locks.
    """
    def __init__(self):
        self._state = _Publication()

    @staticmethod
    def _rotate(state, now):
        if now is None:
            now = state.now_ns
        second = 0 if now is None else now // SECOND_NS
        current = state.current
        if current is not None and second <= current.second:
            return state
        history = state.history
        if current is not None:
            history = tuple(b for b in (*history, current) if second - b.second < 60)
        return state._replace(history=history, current=_Bucket(second))

    @staticmethod
    def _count(state, name):
        state = CaptureCadenceObserver._rotate(state, state.now_ns)
        bucket = state.current
        counts = list(bucket.counters)
        index = COUNTERS.index(name)
        clipped = counts[index] + 1 + sum(b.counters[index] for b in state.history) > COUNT_CAP
        counts[index] = min(COUNT_CAP, counts[index] + 1)
        return state._replace(current=bucket._replace(counters=tuple(counts),
            clipped=bucket.clipped or clipped), clipped=state.clipped or clipped)

    @staticmethod
    def _invalid(state):
        return CaptureCadenceObserver._count(state, 'invalidTiming')

    @staticmethod
    def _admit(state, values):
        state = CaptureCadenceObserver._rotate(state, state.now_ns)
        bucket = state.current
        stages = []
        clipped = False
        for index, (old, value) in enumerate(zip(bucket.stages, values)):
            hit = (old.count + 1 + sum(b.stages[index].count for b in state.history) > COUNT_CAP
                or old.total + value + sum(b.stages[index].total for b in state.history) > DURATION_CAP_NS)
            clipped |= hit
            local_hit = old.count >= COUNT_CAP or old.total + value > DURATION_CAP_NS
            stages.append(_Stage(min(COUNT_CAP, old.count + 1),
                min(DURATION_CAP_NS, old.total + value),
                value if old.maximum is None else max(old.maximum, value), old.clipped or local_hit))
        maximum = bucket.maximum
        if maximum is None or values[0] > maximum[0]:
            maximum = values
        return state._replace(current=bucket._replace(stages=tuple(stages), last=values,
            maximum=maximum, clipped=bucket.clipped or clipped), clipped=state.clipped or clipped)

    def start(self, started_ns, *, capture_generation, target_generation, min_interval_ns):
        state = self._state
        now = _scalar(started_ns)
        valid_now = now is not None and (state.now_ns is None or now >= state.now_ns)
        capture, target = _generation(capture_generation), _generation(target_generation)
        minimum = _bounded(min_interval_ns)
        valid = valid_now and capture is not None and target is not None and minimum is not None
        if valid_now:
            state = self._rotate(state._replace(now_ns=now), now)
        previous = state.pending
        if previous is not None:
            if not valid or previous.start is None:
                state = self._invalid(state)
            elif previous.capture != capture or previous.target != target or previous.finish is None:
                state = self._count(state, 'discontinuous')
            else:
                grab, post, sleep_start, sleep_end, requested, wait, critical = previous.finish
                ordered = (previous.start <= grab <= post <= sleep_start <= sleep_end <= now)
                interval = now - previous.start
                values = (interval, grab - previous.start, post - grab,
                    sleep_end - sleep_start, interval - (post - previous.start) - (sleep_end - sleep_start),
                    previous.minimum, requested, max(0, sleep_end - sleep_start - requested), wait, critical)
                if (not ordered or wait + critical > post - grab or
                        any(v < 0 or v > DURATION_CAP_NS for v in values)):
                    state = self._invalid(state)
                    if any(v > DURATION_CAP_NS for v in values):
                        state = state._replace(clipped=True)
                else:
                    state = self._admit(state, values)
        elif not valid:
            state = self._invalid(state)
        if minimum is None and _scalar(min_interval_ns) is not None and min_interval_ns > DURATION_CAP_NS:
            state = state._replace(clipped=True)
        self._state = state._replace(pending=_Cycle(now if valid else None, capture, target, minimum),
            state='active', phase='grab', phase_ns=now if valid_now else None)

    def finish(self, *, grab_finished_ns, post_grab_finished_ns, sleep_started_ns,
               sleep_finished_ns, sleep_requested_ns, publish_lock_wait_ns,
               publish_critical_ns, published):
        state = self._state
        pending = state.pending
        endpoints = tuple(_scalar(v) for v in (grab_finished_ns, post_grab_finished_ns,
                                               sleep_started_ns, sleep_finished_ns))
        durations = tuple(_bounded(v) for v in (sleep_requested_ns, publish_lock_wait_ns, publish_critical_ns))
        values = endpoints + durations
        forward = endpoints[3] is not None and (state.now_ns is None or endpoints[3] >= state.now_ns)
        if forward:
            state = self._rotate(state._replace(now_ns=endpoints[3]), endpoints[3])
        if type(published) is bool and pending is not None and pending.finish is None:
            state = self._count(state, 'published' if published else 'discarded')
        if (pending is None or pending.finish is not None or pending.start is None or any(v is None for v in values)
                or type(published) is not bool or
                not (pending.start <= endpoints[0] <= endpoints[1] <= endpoints[2] <= endpoints[3])
                or not forward):
            state = self._invalid(state)
            if any(_scalar(v) is not None and v > DURATION_CAP_NS for v in
                   (sleep_requested_ns, publish_lock_wait_ns, publish_critical_ns)):
                state = state._replace(clipped=True)
            self._state = state._replace(pending=None)
            return
        state = self._rotate(state._replace(now_ns=endpoints[3]), endpoints[3])
        self._state = state._replace(pending=pending._replace(finish=values))

    def break_continuity(self, reason):
        reason = reason if type(reason) is str and reason in REASONS else 'unknown'
        state = self._state
        if state.pending is not None:
            state = self._count(state, 'discontinuous')
        if reason in ('error', 'publish-error'):
            state = self._count(state, 'error')
        if reason == 'invalid-clock':
            state = self._invalid(state)
        if reason == 'discarded':
            state = self._count(state, 'discarded')
        phase = reason if reason in ('suspended', 'error', 'stopped') else state.phase
        status = phase if phase in ('suspended', 'error', 'stopped') else state.state
        self._state = state._replace(pending=None, phase=phase, state=status)

    def phase(self, name, now_ns):
        state = self._state
        name = name if type(name) is str and name in PHASES else 'unknown'
        now = _scalar(now_ns)
        valid = now is not None and (state.now_ns is None or now >= state.now_ns)
        if valid:
            state = self._rotate(state._replace(now_ns=now), now)
        else:
            state = self._invalid(state)._replace(pending=None)
        status = name if name in ('suspended', 'error', 'stopped', 'unavailable') else 'active'
        self._state = state._replace(phase=name, phase_ns=now if valid else None, state=status)

    def snapshot(self, now_ns):
        state = self._state  # Exactly one immutable publication reference.
        now = _scalar(now_ns)
        clock_valid = now is not None and (state.now_ns is None or now >= state.now_ns)
        if not clock_valid:
            result = unavailable_capture_cadence()
            result.update(state=state.state, phase=state.phase, clipped=state.clipped)
            return result
        second = now // SECOND_NS
        buckets = tuple(b for b in (*state.history, state.current) if b is not None
            and 0 <= second - b.second < 60)
        stage_results = {}
        clipped = state.clipped
        for i, name in enumerate(STAGES):
            entries = tuple(b.stages[i] for b in buckets)
            raw_count, raw_sum = sum(e.count for e in entries), sum(e.total for e in entries)
            hit = any(e.clipped for e in entries) or raw_count > COUNT_CAP or raw_sum > DURATION_CAP_NS
            clipped |= hit
            count, total = min(COUNT_CAP, raw_count), min(DURATION_CAP_NS, raw_sum)
            maximum = max((e.maximum for e in entries if e.maximum is not None), default=None)
            stage_results[name] = dict(count=count, sumMs=_ms(total) if count else None,
                meanMs=_ms(total / count) if count and not hit else None, maxMs=_ms(maximum))
        counters = {}
        for i, name in enumerate(COUNTERS):
            value = sum(b.counters[i] for b in buckets)
            clipped |= value > COUNT_CAP
            counters[name] = min(COUNT_CAP, value)
        pairs = [b.last for b in buckets if b.last is not None]
        maxima = [b.maximum for b in buckets if b.maximum is not None]
        last = pairs[-1] if pairs else None
        maximum = max(maxima, key=lambda pair: pair[0], default=None)
        interval = stage_results['interval']
        count = interval['count']
        covered = interval['sumMs']
        # Compute rate from integer ns, avoiding rounded-to-zero display values.
        covered_ns = sum(b.stages[0].total for b in buckets)
        rate_valid = count and covered_ns > 0 and interval['meanMs'] is not None
        age = now - state.phase_ns if clock_valid and state.phase_ns is not None and now >= state.phase_ns else None
        clipped |= age is not None and age > DURATION_CAP_NS
        return dict(scope=SCOPE, state=state.state, phase=state.phase, phaseAgeMs=_ms(age),
            intervalCount=count, activeIntervalCoveredMs=covered,
            activeIntervalRateHz=count * SECOND_NS / covered_ns if rate_valid else None,
            lastInterval=_pair(last), maxInterval=_pair(maximum), stages=stage_results,
            **counters, clipped=clipped)
