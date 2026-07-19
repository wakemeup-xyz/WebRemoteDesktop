# Manual STUN Port Search Design

## Goal

Add a user-triggered STUN recovery tool that repeatedly rebuilds the WebRTC connection so the browser and Host request fresh system-assigned UDP ports. The search runs only after the user clicks a dedicated button and stops after at most 500 connection rounds.

## Constraints

1. Browsers do not expose an API for choosing the local ICE UDP port.
2. The installed `aiortc` / `aioice` stack binds UDP sockets to port `0`, so macOS chooses the Host port.
3. `RTCPeerConnection.restartIce()` may reuse the existing socket and port. A search round must therefore create a new PeerConnection on the Viewer; the forwarded offer already makes the Host close and recreate its PeerConnection.
4. A new PeerConnection usually receives new ports, but the operating system may reuse a prior port. The UI must report connection rounds and unique observed ports separately.
5. Strict STUN remains in force. Search failure must not automatically switch to TURN or the Socket.IO media tunnel.

## User Experience

Add a `搜索端口` button beside the existing network control.

- The button is available only in `auto` or `stun` mode with a connected signaling socket and an online Host.
- Clicking it starts a fresh search session and changes the label to `停止搜索`.
- Clicking it again stops future rounds without forcing the current PeerConnection closed.
- Switching network mode, disconnecting, logging out, or starting a normal manual refresh cancels the search.
- Normal WebRTC failures keep the existing bounded recovery behavior. They do not start the 500-round search.

While searching, the existing candidate status displays:

```text
端口搜索 27/500 · Viewer UDP 53114 · Host UDP 49702 · 唯一端口 41
```

If ICE gathering has not exposed a candidate yet, the relevant side displays `分配中`. IP addresses are not shown. On success, the UI displays the successful round and selected Viewer/Host UDP ports. On exhaustion, it reports that all 500 rounds failed and keeps the current Strict STUN fallback guidance.

## Search State

Create a small `StunPortSearchController` that owns deterministic search state and no browser APIs:

```js
{
  active: false,
  status: "idle" | "searching" | "succeeded" | "stopped" | "exhausted",
  attempt: 0,
  limit: 500,
  viewerPorts: [],
  hostPorts: [],
  uniquePorts: [],
  stableMediaSamples: 0,
  lastReason: ""
}
```

Its public operations are:

1. `start()` resets prior state and activates the session.
2. `beginAttempt(reason)` increments the round and clears current-round ports.
3. `recordPort(side, port)` validates and deduplicates candidate ports.
4. `observeMedia(stats)` succeeds after three consecutive one-second samples have decoded video frames and a selected candidate pair.
5. `failAttempt(reason)` reports whether another round remains.
6. `stop(reason)` cancels future rounds.
7. `snapshot()` returns a diagnostic-safe state containing ports but no IP addresses.

## Connection Flow

```text
User clicks Search
  -> validate mode/socket/Host
  -> start controller
  -> rebuild Viewer PeerConnection
  -> Host receives offer and rebuilds Host PeerConnection
  -> collect Viewer and Host candidate UDP ports
  -> wait for selected pair plus 3 stable video samples
       -> success: stop and retain connection
       -> ICE/PC failure: begin next round
       -> 10 second timeout: begin next round
       -> round 500 failure: stop as exhausted
```

Only one round timer may exist. A generation token prevents stale ICE, answer, timeout, or stats callbacks from an earlier PeerConnection from advancing the current search.

## Integration

### Viewer

- Load `stun-port-search-controller.js` before `webrtc.js`.
- Add controller lifecycle methods to `WebRTC`.
- Record local ports from `onicecandidate`.
- Record Host ports from forwarded remote candidates.
- Feed normalized receiver stats into the controller.
- When search is active, route ICE/PC failures and the per-round timeout to a full PeerConnection rebuild.
- Keep existing normal reconnect behavior unchanged when search is inactive.

### Signal Server and Host

No new signaling event is required. Existing offer forwarding and Host `on_offer` behavior already close and recreate the Host PeerConnection. Existing candidate forwarding exposes candidate metadata needed by the Viewer.

### Diagnostics

Add the controller snapshot to `collectNetworkSnapshot()` as `stunPortSearch`. Keep at most the current-round ports and aggregate unique-port count in uploaded diagnostics to avoid unbounded payload growth.

## Timing and Resource Limits

- Maximum rounds: 500.
- Per-round deadline: 10 seconds.
- Delay between rounds: 250 milliseconds.
- Maximum worst-case duration: about 85 minutes.
- Only one PeerConnection exists at a time.
- Search stops immediately on success, user cancellation, mode change, disconnect, or logout.

## Error Handling

- If the button is clicked outside `auto/stun`, show guidance to select a direct mode and do not change modes automatically.
- If signaling is offline or Host is offline, do not start.
- Candidate parse failures display `分配中` and do not fail the round by themselves.
- Repeated system-assigned ports are allowed but counted once in the unique-port metric.
- Stale callbacks are ignored by comparing the captured PeerConnection/generation with the active round.
- Search exhaustion emits one terminal diagnostic, not one upload per failed round.

## Tests

### Controller unit tests

1. Search cannot exceed 500 rounds.
2. Candidate ports are validated and deduplicated by side.
3. Repeated ports do not inflate unique-port count.
4. Three consecutive good media samples succeed; an empty sample resets stability.
5. Stop and reset prevent stale state from advancing.

### WebRTC integration tests

1. Search starts only from the button/API and only in `auto/stun`.
2. An active search failure schedules a full PeerConnection rebuild instead of normal ICE restart recovery.
3. Search-inactive failures preserve existing recovery behavior.
4. Viewer and Host candidate ports update the status text without displaying IP addresses.
5. A round timeout advances once and stale timers are ignored.
6. Success, stop, mode switch, disconnect, and exhaustion clear timers and restore the button.
7. Search exhaustion never calls TURN or `startTunnelRelay()`.

### Browser acceptance

1. The button starts and stops a visible search session.
2. Attempt and port text remains readable on desktop and mobile widths.
3. A successful local connection stops the search after stable video appears.
4. Console output contains no uncaught errors during repeated start/stop cycles.

## Acceptance Criteria

1. The 500-round loop never starts without an explicit button click.
2. Every active round creates a new Viewer PeerConnection and consequently a new Host PeerConnection.
3. The UI shows round progress and observed Viewer/Host UDP ports without IP addresses.
4. Success requires a selected candidate pair and three consecutive seconds of decoded video.
5. Search is bounded, cancellable, generation-safe, and leaves Strict STUN fallback policy unchanged.
