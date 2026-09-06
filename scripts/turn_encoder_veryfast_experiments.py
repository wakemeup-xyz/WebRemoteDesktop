"""Immutable contract and fail-closed validators for the veryfast-only matrix."""

from __future__ import annotations

from typing import Any, Mapping

import turn_encoder_experiments as _preset


ExperimentConfig = _preset.ExperimentConfig
RELAY_RESOLUTIONS = _preset.RELAY_RESOLUTIONS
submitted_options = _preset.submitted_options


def build_veryfast_experiments() -> tuple[ExperimentConfig, ExperimentConfig]:
    """Return the complete superfast control and sole veryfast candidate."""
    return (
        _preset._config("on-demand-cap-vbv200-superfast", "superfast"),
        _preset._config("on-demand-cap-vbv200-veryfast", "veryfast"),
    )


def validate_control_integrity(base: Mapping[str, Any]) -> list[str]:
    """Reject a malformed superfast control before measuring the candidate."""
    control, _ = build_veryfast_experiments()
    return _preset._evidence_errors(
        "base", base, control, enforce_quality=False, enforce_cost=False,
    )


def validate_comparison(base: Mapping[str, Any], candidate: Mapping[str, Any]) -> list[str]:
    """Apply all frozen quality, cost, input, PTS and actual-options gates."""
    control, proposed = build_veryfast_experiments()
    errors = validate_control_integrity(base)
    errors.extend(_preset._evidence_errors(
        "candidate", candidate, proposed, enforce_quality=True, enforce_cost=True,
    ))
    if errors:
        return errors

    if base.get("input") != candidate.get("input"):
        errors.append("candidate: input drift")
    for resolution in RELAY_RESOLUTIONS:
        base_resolution = next(run for run in base["runs"] if tuple(run["resolution"]) == resolution)
        candidate_resolution = next(run for run in candidate["runs"] if tuple(run["resolution"]) == resolution)
        base_scenarios = {scenario["scenarioId"]: scenario for scenario in base_resolution["scenarios"]}
        candidate_scenarios = {scenario["scenarioId"]: scenario for scenario in candidate_resolution["scenarios"]}
        for scenario_id, base_scenario in base_scenarios.items():
            for base_frame, candidate_frame in zip(
                base_scenario["frames"], candidate_scenarios[scenario_id]["frames"]
            ):
                if base_frame["inputHash"] != candidate_frame["inputHash"]:
                    errors.append(f"candidate: {scenario_id}: input hash drift")
                if base_frame["pts"] != candidate_frame["pts"]:
                    errors.append(f"candidate: {scenario_id}: PTS drift")
    return errors
