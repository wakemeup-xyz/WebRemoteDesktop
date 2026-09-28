import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("summarize-wrd-incident.py")
SPEC = importlib.util.spec_from_file_location("wrd_incident_summary", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def test_summary_counts_media_and_preserves_not_run_boundaries(tmp_path):
    log = tmp_path / "back.log"
    log.write_text(
        "2026-09-28 WRD_ENCODER_RATE applyMode=no-op reopenRequired=False\n"
        "2026-09-28 WRD_ENCODER_RATE applyMode=reopen-required reopenRequired=True\n"
        '2026-09-28 host_event_loop_lag {"maxLagMs": 120.5, "severity":"critical"}\n'
        "2026-09-28 dc-error connectionAttemptId=attempt-a\n",
        encoding="utf-8",
    )

    summary = MODULE.summarize([log])

    assert summary["mediaApply"] == {
        "setterLogLines": 2,
        "noOpLogLines": 1,
        "reopenRequiredLogLines": 1,
    }
    assert summary["eventLoop"] == {"criticalCount": 1, "maxLagMs": 120.5}
    assert summary["counts"]["dc-error"] == 1
    assert summary["acceptance"]["realTurn"] == "NOT RUN"


def test_examples_do_not_copy_arbitrary_log_payloads(tmp_path):
    log = tmp_path / "back.log"
    log.write_text(
        '2026-09-28 12:00:00 dc-error token=secret-password inputText=private\n',
        encoding="utf-8",
    )

    summary = MODULE.summarize([log])

    example = summary["examples"]["dc-error"][0]
    assert "dc-error" in example
    assert "secret-password" not in example
    assert "private" not in example
