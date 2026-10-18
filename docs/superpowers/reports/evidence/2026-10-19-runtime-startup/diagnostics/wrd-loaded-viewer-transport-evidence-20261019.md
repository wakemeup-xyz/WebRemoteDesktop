# Loaded Viewer transport evidence (2026-10-19)

Same R4 sample file was parsed once more; no new logs, source reads or live operations. Global qualification remains failed-or-indeterminate. This supplement preserves the prior startup report.

Viewer `fefc555aea9640b563bfd22f5b36b6b8ca6365ec`, build `a3671ba674ad7516`; 312 saved observations. Samples SHA256 `a96b18e67f05febca112059404495c1db7dd1c24da20f182438a15d852bf25cc` (1164155 bytes). Latest transport is relay↔relay UDP, video/h264.

| Existing record keypath | Numeric rows | Min | Max | Latest | Semantics |
|---|---:|---:|---:|---:|---|
| sample.transport.rttMs | 304 | 28 | 161 | 33 | raw WebRTC transport RTT snapshot; ms |
| sample.transport.bytesReceived | 303 | 128982 | 7467491 | 7467491 | raw cumulative WebRTC transport counter; bytes |
| sample.transport.framesDecoded | 303 | 12 | 5111 | 5111 | raw cumulative decoded-frame counter; frames |
| sample.transport.framesDropped | 303 | 0 | 0 | 0 | raw cumulative dropped-frame counter; frames |
| sample.metrics.candidateRttMs.last | 303 | 28 | 161 | 45 | rolling application window latest RTT sample; ms |
| sample.metrics.jitterBufferMs.last | 301 | 4.5 | 104.3 | 61.4 | rolling application window latest jitter-buffer sample; ms |
| sample.metrics.decodeMs.last | 301 | 1.09863158 | 3.7034 | 2.43589474 | rolling application window latest decode sample; ms |
| sample.metrics.paintIntervalMs.last | 303 | 16.6 | 216.7 | 50 | rolling application window latest paint-interval sample; ms |
| sample.metrics.encoderMs.last | 0 | null | null | null | rolling application window latest encoder sample; ms |
| sample.metrics.relayFrameAckRttMs.last | 0 | null | null | null | rolling application window latest relay-ACK RTT sample; ms |

Numeric-row count counts persisted observations, not unique packets, frames or metric events. Min/max/latest describe saved values only. Rolling application windows are five seconds, overlap, and their producer counts must not be added. No whole-run P95 is reconstructed. Counter extrema are not rates or durations.

Capture-time, relay-queue, and packet-loss evidence are absent from persisted transport/metric fields. framesDropped cannot establish packet loss. Encoder and relay-frame ACK metrics exist but have no numeric samples. No one-way latency, cross-clock duration or capture-to-visible effect is inferred. Six input metrics remain null and are not re-counted; native/business/visible/physical stay NOT_RUN.

The added read is 1,164,155 bytes from the same exact file. Cumulative original-artifact reads are 4,705,760 bytes (six unique artifacts, 1,188,725 unique bytes); with the two previously read source files, tracked artifact/source bytes are 4,887,992. No new unique artifact or source file was read. Exact source and evidence provenance remain in the startup JSON.
