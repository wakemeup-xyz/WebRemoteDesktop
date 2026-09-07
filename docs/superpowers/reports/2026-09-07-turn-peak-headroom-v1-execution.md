# Peak-headroom v1 offline execution

The single authorized offline candidate `on-demand-peak-headroom-v1` is **NO_QUALIFIED_CANDIDATE**.  Production remains `relay-legacy-v1`; no runtime gate ran and no Host, Signal, Viewer, tunnel, policy environment, or service process was changed.

The candidate froze libx264 `superfast`, Baseline, 20 FPS, one thread, zerolatency, no B-frames/lookahead/scenecut/open GOP/intra refresh, forced IDR, repeat headers, and `keyint=min-keyint=1201`.  Average bitrate was 3.2/5.0 Mbps at 720p/1080p; submitted `vbv-maxrate` was independently 4.8/7.2 Mbps, `vbv-bufsize` 1000/1300 kbit, and `vbv-init=1`.  Codec creation records captured the actual submitted average bitrate, maxrate, buffer size, init and options.  Each scenario had exactly one initial codec construction; no runtime reopen or temporary bitrate change occurred.

The fresh-codec safety pre-screen ran frames 0 through 1225 at both resolutions.  Actual bitstream IDRs occurred exactly at initial frame 0 and safety-net frame 1201.  Its quality gates passed: 720p safety-net PSNR/MAE was 32.228 dB / 2.903 and 1080p was 31.865 dB / 2.497.  This allowed the one complete five-scenario matrix to run.

The complete matrix rejected the candidate on the fixed change-MAE limit of 3.  At 720p, scrolling on-demand IDRs reached 15.137 and 14.809; post-scroll on-demand IDRs reached 3.143 and 3.047.  At 1080p, scrolling on-demand IDRs reached 10.250 and 10.083.  These failures remain even though all listed IDR PSNR values were at least 30.887 dB and all structural checks for input hashes, PTS, IDR schedule, byte evidence, actual options and reopen count passed.

The raw matrix overlapped an external StockHub composite pytest/npm/build process that started after the preflight.  Its P95 results are retained as evidence but marked `CONTAMINATED` and were not used to qualify the candidate.  A clean timing rerun would only be allowed if quality and IDR gates had first passed; they did not, so no rerun or parameter sweep was performed.

Artifacts: [raw evidence](evidence/2026-09-07-turn-peak-headroom/relay-peak-headroom-v1.raw.json) (`75c0c22d905826bacc46303a547c7f78b971d1c164368937a508750bc58a2315`) and [execution sidecar](evidence/2026-09-07-turn-peak-headroom/relay-peak-headroom-v1.sidecar.json).
