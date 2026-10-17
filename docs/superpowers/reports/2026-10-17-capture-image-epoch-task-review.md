# Capture image epoch independent task review

Result: PASS — no actionable findings.

Reviewed commit `83c513e2c4da7a6b83e564c98ec7ebf96154cea3` against its parent, both changed files, the capture-image-epoch design and implementation plan, and surrounding recv/lifecycle/causality paths.

- Resolution uses the existing monitor and absolute caps before comparison under the target lock. Only an effective target dimension change increments the image epoch, once, and releases reservations once. Equivalent capped requests return unchanged effective dimensions.
- FPS remains capped to 5..30 and updates pacing without changing image epoch or releasing reservations; repeated FPS returns without side effects. apply reports the setter effective result.
- Synthetic cache regression preserves 1152x720 pixels, capture sequence/bounds, and cache/reused/non-fresh trace flags through FPS changes. The in-flight regression preserves new pixels and capture identity during FPS changes.
- True resize still fences old in-flight work; strengthened test verifies new-size blank output instead of old pixels. Capture-generation pause/resume and shutdown guards remain intact and their selected offline tests pass.
- Production diff is confined to the resolution/FPS setters and apply return handling. No peak qualification, encoder/codec policy, quality-lock, or network changes.

Independent validation: Python `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11`, pytest selected `test_frame_worker.py`, `test_media_stage_boundaries.py`, `test_input_frame_causality.py`, `test_quality_lock.py`, `test_h264_encoder_policy.py`: **105 passed, 3 deselected in 7.77s**.

Exact filter: `not capture_loop_pauses_grabs_then_resumes_fresh_dimensions_pts_and_input_effect and not capture_constructor_initializes_stats_without_native_capture and not host_constructor_rejects_unvalidated_v2_before_starting_host_resources`.

Validation limits: the three constructor tests were excluded per review constraints, including the mocked capture-constructor tests; no real Host or ScreenCaptureTrack constructor, MSS capture, native input, production request, browser, service operation, dependency install, or build was performed. This establishes selected offline regression behavior only; production loading and real session acceptance were NOT RUN. Repository source and index were not modified by this review.
