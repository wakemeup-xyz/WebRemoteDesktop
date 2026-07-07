# Shared Web Terminal Design

## Background

WebRemoteDesktop already exposes a browser-based Web Terminal inside the existing Viewer page. The current implementation uses `@xterm/xterm` on the frontend, `node-pty` on the `signal-server`, and a dedicated Socket.IO namespace at `/terminal`.

The intended product rule in existing docs is already clear:

- Terminal does not use STUN, TURN, or WebRTC DataChannels.
- Terminal should survive ordinary desktop network-mode changes.
- Terminal sessions should remain alive until explicit close or service restart.

However, the current implementation does not fully realize those rules:

1. Frontend lifecycle is tab-driven. `web-client/js/terminal.js` only connects the terminal socket when the user opens the Terminal tab, so terminal liveness is still coupled to current page UI state.
2. Session scope is modeled as user-owned via `ownerSub`, but current admin JWT uses a fixed `sub` (`terminal-admin-login`), so “shared sessions” exist only as an incidental side effect rather than an explicit design.
3. PTY output is wired to a single callback per session, so multi-viewer attach is not modeled as a first-class broadcast system.
4. The current snapshot model exposes sessions but not shared-pool presence, observer membership, replay state, or reconnect semantics.

The user requirement for this design is stronger and explicit:

- All users who pass terminal admin authorization should enter the same shared shell session pool.
- Multiple computers may attach to the same terminal session simultaneously.
- Simultaneous input is allowed; whoever types affects the shared shell immediately.
- Closing the Terminal panel or the whole Viewer page must not terminate shared terminal sessions.
- A user who reopens the page later should be able to reattach and continue.

## Goals

1. Make shared terminal sessions a first-class product architecture, not an accidental result of a fixed admin JWT subject.
2. Fully decouple terminal session lifetime from remote desktop network mode, WebRTC media state, and terminal tab visibility.
3. Support a single shared terminal pool for all admin-authorized users.
4. Allow multiple observers/controllers to attach to the same PTY simultaneously.
5. Preserve PTY state when a viewer disconnects, closes the tab, or switches back to the desktop tab.
6. Support reconnect and recent-output replay so a returning user can recover context.
7. Keep deployment simple: no database, no separate terminal service, no changes to the Python Host media path.
8. Preserve clear security boundaries: terminal remains disabled by default and requires separate admin authorization.

## Non-Goals

1. No SSH gateway or remote-host management in this phase.
2. No cross-server-restart session recovery; service restart still terminates in-memory PTYs.
3. No durable command/output recording by default.
4. No terminal transport over STUN, TURN, or WebRTC.
5. No independent WeTTY/ttyd sidecar as the main product path.

## Architecture Review

### Existing Architecture Facts

Current relevant components:

- `web-client/js/terminal.js`
  - renders xterm instances
  - opens `/terminal` Socket.IO connection after Terminal tab is shown
  - keeps session metadata in page-local state
- `signal-server/websocket/terminal.js`
  - enforces admin JWT
  - exposes create, attach, detach, close, input, resize
- `signal-server/lib/terminal/session-manager.js`
  - creates one PTY per terminal session
  - keeps sessions in memory
  - currently stores `ownerSub`
  - currently tracks only one `onData`/`onExit` callback per session
- `signal-server/routes/auth.js`
  - provides `/api/auth/login/admin`
- `web-client/js/webrtc.js`
  - owns remote desktop signaling and network-mode switching
  - should not own terminal lifecycle

### Architectural Problem

The current design mixes two different concepts:

1. Session process lifetime
2. Current page’s attachment to that session

This is the main reason terminal behavior still feels dependent on desktop/network/UI state. The PTY can outlive the page, but the frontend and protocol do not model shared observers and reattachment cleanly enough.

### Required Architectural Shift

The system must move from:

- “a terminal session belongs to an admin subject”

to:

- “a terminal session belongs to the shared terminal pool; clients only attach and detach”

That shift produces clear boundaries:

- PTY lifetime is a server concern.
- Attach/detach is an observer concern.
- Terminal tab visibility is only a presentation concern.
- Desktop WebRTC mode is unrelated to terminal state.

## Options Considered

### Option A: Minimal patch on current model

Keep `ownerSub`, keep current session model, and only make the frontend connect earlier and reconnect better.

Pros:

- smallest code delta
- fastest short-term patch

Cons:

- “shared” behavior still relies on accidental fixed `sub`
- observer presence and broadcast remain under-modeled
- reconnect and replay remain fragile
- future auth changes could silently break sharing

Verdict: rejected.

### Option B: Shared terminal pool as a first-class domain model

Keep the existing `signal-server` deployment shape, but redesign terminal semantics around:

- shared pool
- shared sessions
- per-client observer attachments
- PTY output broadcast
- explicit replay buffer

Pros:

- matches the requested product behavior exactly
- keeps current deployment and auth shape
- clean separation between PTY lifetime and viewer lifecycle
- enables future enhancements such as read-only mode or control arbitration without redesign

Cons:

- larger change than a patch
- needs protocol and state-model migration

Verdict: recommended.

### Option C: Separate terminal hub service

Move terminal into its own service/process and let the main app proxy auth.

Pros:

- strongest long-term isolation

Cons:

- unnecessary complexity now
- more moving parts in startup, deployment, and tunnel exposure
- weak fit for current repo scale

Verdict: rejected for this phase.

## Recommended Architecture

### High-Level Structure

```text
Browser Viewer
  ├─ Desktop workspace
  │    └─ existing WebRTC media + input path
  └─ Terminal workspace
       ├─ persistent terminal controller
       ├─ shared session pool UI
       └─ xterm views attached to shared sessions

Signal Server
  ├─ existing auth/static/signaling routes
  ├─ terminal bootstrap endpoint
  ├─ /terminal Socket.IO namespace
  ├─ shared terminal pool registry
  ├─ shared session manager
  ├─ observer registry
  ├─ output replay buffer
  └─ node-pty
```

### Core Rule

Terminal sessions are no longer user-owned. They belong to the shared terminal pool and persist until explicit close or service restart.

### Separation of Concerns

- WebRTC network mode controls only desktop media behavior.
- Terminal authorization controls only whether the browser can attach to `/terminal`.
- Terminal UI tabs control only what is visible in the page.
- PTY lifecycle is controlled only by server-side terminal session management.

## Domain Model

### TerminalPool

Represents the shared terminal workspace.

Fields:

- `poolId`
- `title`
- `defaultSessionId`
- `sessionIds[]`

Phase 1 uses one fixed pool:

- `poolId = "default"`

### TerminalSession

Represents one PTY-backed shared shell session.

Fields:

- `sessionId`
- `poolId`
- `title`
- `shell`
- `cwd`
- `status`: `running | exited | closed`
- `createdAt`
- `lastActiveAt`
- `exitCode`
- `signal`
- `observerCount`
- `lastOutputSeq`

Notably absent:

- no `ownerSub`

### TerminalObserver

Represents one browser attachment to one shared session.

Fields:

- `observerId`
- `clientId`
- `socketId`
- `sessionId`
- `attachedAt`
- `lastSeenAt`
- `isActivePresenter`

### TerminalAuditEvent

Represents structured audit events without recording full terminal IO by default.

Fields:

- `eventType`
- `poolId`
- `sessionId`
- `observerId`
- `clientId`
- `role`
- `timestamp`
- `meta`

## Session Lifecycle

### Creation

1. An admin-authorized browser requests `terminal:create_session`.
2. The server spawns a PTY using configured shell and cwd.
3. The server adds the session to the shared pool.
4. The creating client becomes an attached observer of that session.
5. The new session is broadcast to all connected admin clients.

### Attachment

1. A client chooses an existing session.
2. The server registers a new observer for that client and session.
3. The server replays recent buffered output for the session.
4. Live PTY output is then broadcast to all observers attached to the session.

### Detachment

Detachment removes only the observer attachment. It does not stop the PTY.

Triggers:

- client explicitly leaves the session
- page closes
- socket disconnects
- terminal panel is hidden and the client chooses to detach manually

### Closure

Only explicit session close should kill the PTY.

Triggers:

- user presses “close session”
- service restarts
- future admin-only cleanup operations

Close behavior:

- kill PTY
- mark session closed
- broadcast session exit/close to all observers
- remove session from pool registry

### Page Close and Browser Disconnect

Closing the page must not destroy terminal sessions.

Rules:

- frontend must not emit `close_session` on page unload
- frontend may attempt best-effort `detach_session`
- server must also clean observer state on socket disconnect
- PTY survives even if observer count becomes zero

## Shared Concurrency Semantics

### Input

All attached admin observers may send terminal input concurrently.

Rules:

- no write lock
- no single-controller arbitration in phase 1
- per-socket event order is preserved naturally by Socket.IO/Node event processing
- cross-client input order is determined by arrival order at the server

This is an intentional shared-console behavior, not a bug.

### Output

PTY output must be broadcast to every observer attached to the same session.

This requires changing the session manager from a single `onData` callback model to:

- `session.observers = Map<observerId, observer>`
- broadcast hooks per observer socket

### Resize

Resize needs conflict control because multiple observers may have different viewport sizes.

Recommended phase-1 rule:

- only the currently active presenter for a session may change the PTY size
- all other observers still fit locally, but do not mutate server PTY dimensions
- active presenter may be updated when a client explicitly activates a session tab

This avoids resize thrash while keeping implementation understandable.

Fallback simplification if needed:

- keep fixed PTY dimensions such as `120x32`

But the preferred design is active-presenter resize.

## Replay and Recovery

### Why Replay Is Required

If a browser closes and later reconnects, the PTY may still be alive but the user would otherwise miss everything printed while they were away.

Therefore each session needs a bounded replay buffer.

### Replay Buffer Design

Each session stores:

- `outputRingBuffer`
- `lastOutputSeq`

Buffer policy:

- bounded by bytes or lines
- recommended initial bound: `256 KB` or `2000` lines
- oldest content is truncated first
- truncation should be visible in metadata or a synthetic marker

Attach flow:

1. observer attaches
2. server sends buffered output snapshot
3. server starts live output stream

### Client Reconnect

Client-side persistence should be split:

- `sessionStorage`
  - admin token
  - stable browser `clientId`
- `localStorage`
  - last attached session ids
  - last active session id

Reconnect flow:

1. page loads
2. terminal controller restores local session hints
3. after admin auth, fetch bootstrap and pool snapshot
4. auto-reattach last active shared session if it still exists
5. otherwise show the shared pool and attach default session when chosen

## Protocol Design

### HTTP

#### `POST /api/auth/login/admin`

Keep existing endpoint.

Role:

- returns admin JWT
- remains separate from normal viewer login

#### `GET /api/terminal/bootstrap`

New endpoint.

Returns:

- terminal enabled state
- pool metadata
- default session id
- session soft-warning threshold
- current shared session summaries

Purpose:

- let the frontend render terminal state before or alongside socket attach
- avoid overloading initial socket connection as the only source of truth

### Socket Namespace

Namespace remains:

- `/terminal`

Recommended event contract:

- `terminal:pool_snapshot`
- `terminal:create_session`
- `terminal:session_created`
- `terminal:attach_session`
- `terminal:session_attached`
- `terminal:detach_session`
- `terminal:session_detached`
- `terminal:close_session`
- `terminal:session_closed`
- `terminal:input`
- `terminal:resize`
- `terminal:output`
- `terminal:replay`
- `terminal:exit`
- `terminal:presence`
- `terminal:warning`
- `terminal:error`

The main change is semantic clarity:

- events operate on shared sessions in a pool
- events are not phrased as private per-user tabs

## Frontend Design

### Controller Lifetime

`TerminalPanel` should become a page-level terminal controller.

Rules:

- initialize on page load
- terminal socket lifecycle is independent of whether the terminal tab is currently visible
- the terminal tab only toggles visibility of the terminal workspace

### UI Model

The UI should explicitly show a shared session pool rather than implying personal ownership.

Minimum visible concepts:

- shared session list
- current session title
- observer count
- current connection state
- create session
- close session
- reconnect/reattach state
- warning that input is shared among attached viewers

### Desktop/Terminal Separation

Important product rule:

- remote desktop “disconnect” only disconnects desktop media/signaling
- it must not disconnect the shared terminal pool

That rule should be reflected both in code and UI wording.

## Backend Design

### Session Manager Changes

`signal-server/lib/terminal/session-manager.js` must change from:

- single session owner
- single data callback

to:

- shared pool registry
- shared session registry
- observer registry
- replay buffer
- broadcast helpers

Core responsibilities:

1. create and close shared PTY sessions
2. attach and detach observers
3. broadcast PTY output
4. track observer counts and presence
5. serve replay content
6. apply resize arbitration

### Terminal Namespace Changes

`signal-server/websocket/terminal.js` must:

- authenticate admin JWT as before
- stop using `ownerSub` for session access control
- route all operations through shared-pool semantics
- broadcast session changes and presence updates to connected admin clients

### Auth Design

Admin token remains separate and required.

Important rule:

- shared behavior must not depend on a fixed `sub` value

Even if the JWT `sub` later changes to represent unique admin logins or browser instances, session sharing must still work because shared access is pool-based, not owner-based.

## Configuration

Existing terminal config remains valid:

- `WRD_ENABLE_TERMINAL`
- `WRD_TERMINAL_ADMIN_PASSWORD`
- `WRD_TERMINAL_SHELL`
- `WRD_TERMINAL_CWD`
- `WRD_TERMINAL_SOFT_WARN_SESSION_COUNT`
- `WRD_TERMINAL_IDLE_TIMEOUT_MS`
- `WRD_TERMINAL_STARTUP_TIMEOUT_MS`
- `WRD_TERMINAL_AUDIT_LOG`
- `WRD_TERMINAL_RECORD_IO`

Phase-1 policy:

- `WRD_TERMINAL_IDLE_TIMEOUT_MS=0` continues to mean “do not auto-destroy inactive shared sessions”

No additional required env vars are needed for the first implementation.

## Error Handling

Must fail explicitly for:

- terminal disabled
- admin password not configured
- PTY spawn failure
- attach to missing session
- close missing session
- oversized input payload
- invalid resize payload
- replay buffer unavailable or truncated

No silent fallback to desktop socket or WebRTC transport is allowed.

## Security and Audit

### Security Rules

1. Terminal remains disabled by default.
2. Terminal requires separate admin authorization.
3. Terminal auth is session-scoped in the browser, not persisted indefinitely in product state.
4. Terminal does not reuse desktop WebRTC channels.
5. Full terminal IO is not recorded by default.

### Audit Requirements

At minimum, record:

- admin login success/failure
- shared session creation
- attach
- detach
- reconnect attach
- close
- PTY exit
- spawn failure
- observer count changes

Audit should emphasize session and observer events, not command content.

## Testing Strategy

### Unit Tests

Backend:

- pool bootstrap data
- session creation in shared pool
- observer attach/detach
- broadcast fan-out
- replay buffer truncation
- explicit close behavior
- active-presenter resize arbitration

Frontend:

- terminal controller persists across tab switches
- reconnect restores last active shared session
- desktop disconnect does not tear down terminal controller
- pool snapshot rendering
- shared session warning display

### Integration Tests

1. Create shared session from browser A.
2. Attach browser B to the same session.
3. Verify both receive the same output.
4. Type from A and B; verify shared shell state changes for both.
5. Close browser A tab; verify B remains connected and PTY remains alive.
6. Reopen A; verify it can reattach and receive replay output.
7. Switch remote desktop network mode among `lan`, `auto`, `stun`, `relay`, `tunnel`; verify terminal remains attached and session survives.
8. Click desktop disconnect; verify terminal remains alive.

## Migration Plan

1. Replace `ownerSub`-based terminal access with shared-pool semantics.
2. Upgrade session manager internals to observer-based broadcasting.
3. Introduce bootstrap endpoint and shared-pool snapshot protocol.
4. Upgrade frontend terminal state from per-page private tabs to shared session pool UI and persistent controller.
5. Update docs and runbooks to make terminal independence and shared semantics explicit.

No data migration is required because terminal state is in-memory only.

## Risks and Tradeoffs

### Accepted Tradeoff: Concurrent Input Can Interfere

Multiple users typing into the same shell may interfere with one another.

This is an accepted product behavior because the requested model is a shared console. The UI must communicate this clearly.

### Resize Conflict

Shared sessions make PTY sizing ambiguous.

Mitigation:

- active-presenter resize arbitration

### Memory Growth

Replay buffers can grow without bounds if not capped.

Mitigation:

- hard limit on bytes or lines per session

### High-Impact Close Action

Closing a shared session affects all connected users.

Mitigation:

- confirmation UI
- explicit wording
- audit log

## Acceptance Criteria

1. Terminal sessions do not reconnect or restart when the desktop network mode changes.
2. Terminal socket lifecycle is independent of terminal tab visibility.
3. Closing the Viewer page does not terminate shared PTY sessions.
4. A reopened page can reattach to the shared session pool after admin auth.
5. Two or more computers can attach to the same session and all see the same output stream.
6. Two or more computers can send input to the same session and all input is applied to the shared shell in arrival order.
7. PTY output is broadcast to all attached observers of the session.
8. Shared session replay restores recent output after reconnect.
9. Desktop disconnect does not disconnect terminal.
10. Terminal remains separate from STUN, TURN, and WebRTC transport behavior.

## Implementation Readiness

This design is intentionally scoped so that implementation can happen inside the current repository and service topology:

- no new external service
- no database requirement
- no Python Host changes
- no tunnel restart semantics changes

The next artifact should be a concrete implementation plan that breaks this design into server protocol, shared session manager, frontend controller/UI, tests, and doc updates.
