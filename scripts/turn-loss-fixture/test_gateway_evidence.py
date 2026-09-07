from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest


def _module():
    path = Path(__file__).with_name("gateway_evidence.py")
    spec = importlib.util.spec_from_file_location("gateway_evidence", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_loss_counter_records_forwarded_and_dropped_video_sequences():
    evidence = _module()
    counter = evidence.GatewayLossCounter("every_100th_for_30s", started_ns=100)
    for sequence in range(1, 101):
        counter.observe(sequence=sequence, now_ns=101)
    row = counter.seal(ended_ns=102)
    assert row["eligibleCount"] == 100
    assert row["droppedCount"] == 1
    assert row["forwardedSequences"] == list(range(1, 100))
    assert row["droppedSequences"] == [100]


def test_loss_counter_refuses_to_run_past_its_hard_deadline():
    evidence = _module()
    counter = evidence.GatewayLossCounter("all_for_200ms", started_ns=10, duration_ms=200)
    assert counter.observe(sequence=1, now_ns=10) is False
    assert counter.observe(sequence=2, now_ns=210_000_001) is True
    assert counter.seal(ended_ns=210_000_001)["deadlineExpired"] is True


def test_receiver_capability_is_short_lived_scoped_and_single_use():
    evidence = _module()
    issuer = evidence.ReceiverCapabilityIssuer(b"a" * 32, now_ns=lambda: 100)
    capability = issuer.issue(run_id="run", realm="turn-loss-lab-run", gateway_id="gateway-a", operation="observe", ttl_ns=50)
    assert issuer.consume(capability, run_id="run", realm="turn-loss-lab-run", gateway_id="gateway-a", operation="observe", now_ns=125)
    assert not issuer.consume(capability, run_id="run", realm="turn-loss-lab-run", gateway_id="gateway-a", operation="observe", now_ns=125)


def test_receiver_capability_rejects_a_wrong_authority_scope():
    evidence = _module()
    issuer = evidence.ReceiverCapabilityIssuer(b"a" * 32, now_ns=lambda: 100)
    capability = issuer.issue(run_id="run", realm="turn-loss-lab-run", gateway_id="gateway-a", operation="observe", ttl_ns=50)
    assert not issuer.consume(capability, run_id="other", realm="turn-loss-lab-run", gateway_id="gateway-a", operation="observe", now_ns=125)
