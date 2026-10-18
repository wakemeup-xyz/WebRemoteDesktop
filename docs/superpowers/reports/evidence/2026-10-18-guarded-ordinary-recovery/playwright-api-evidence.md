# Task 5: installed Playwright fault-adapter API evidence

Date: 2026-10-18. Method: static local file/metadata reads, searches and SHA-256 hashing only. No Playwright import, Python execution, browser, network, runtime test, process/service/tunnel observation, installation, build, repository or index write was performed. This file is preparation evidence for the implementer; it does not claim runtime qualification.

## Inputs and exact local installation

Repository root: `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`.

- `.superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-5-brief.md:3-13`: adapter ownership/interfaces, two explicit stimuli, pure fake tests only, no production-method changes.
- `docs/superpowers/specs/2026-10-18-guarded-ordinary-recovery-design.md:159-173`: complete fault-adapter/evidence contract. No alternate design is proposed here.
- Installed package root, abbreviated **P** below: `/Users/macstudio1/.homebrew/lib/python3.11/site-packages/playwright`.
- Installed metadata root, abbreviated **D** below: `/Users/macstudio1/.homebrew/lib/python3.11/site-packages/playwright-1.59.0.dist-info`.
- **Verified distinction:** `D/METADATA:2-3` identifies Python distribution `playwright 1.59.0`; `P/_repo_version.py:20-21` also says `1.59.0`. **The bundled `P/driver/package/package.json:2-3` identifies `playwright-core 1.59.1`.** Do not describe these files as a uniformly version-1.59.0 driver. RECORD contains the observed driver package.json and generated mock source at lines 593 and 222; this report does not diagnose why the version labels differ.
- `P/_impl/_driver.py:25-33` selects the package-local `driver/package/cli.js` and package-local node by default (node executable can be overridden via `PLAYWRIGHT_NODEJS_PATH`). This is static selection logic, not proof of the current interpreter import resolution or an actually launched driver. The supplied Python executable was not invoked.

## Public Python surface and awaiting

All line references are exact local files under P, not web documentation.

| Operation | Verified public async surface | Relevant meaning |
|---|---|---|
| `Page.route_web_socket(url, handler)` | `async_api/_generated.py:9915-9955` | Await registration. URL is string, compiled regex or string predicate; handler gets one `WebSocketRoute`. Only subsequently created WebSockets route; install before navigation. |
| `BrowserContext.route_web_socket` | `async_api/_generated.py:13790-13832` | Context-wide variant; not needed for the page-owned contract. The local example at 13813-13815 contains obsolete-looking `route_send`/`connect` names; use the actual signatures, not that example. |
| `WebSocketRoute.url` | `async_api/_generated.py:1209-1219` | Public URL of the page-created WebSocket. |
| `WebSocketRoute.connect_to_server()` | `async_api/_generated.py:1240-1261` | **Synchronous**, returns the server-side route. Do not `await` it. Default routed sockets do not connect upstream. Automatic bidirectional forwarding is documented unless `on_message` is set on the corresponding side. |
| `WebSocketRoute.close(*, code=None, reason=None)` | `async_api/_generated.py:1221-1237` | **Async**; closes one side. A blocked new WS route can await this public page-side method without connecting upstream. |
| `WebSocketRoute.on_message(handler)` | `async_api/_generated.py:1278-1301` | Overrides automatic forwarding for that direction; Task 5 open routing must not install it. |
| `WebSocketRoute.on_close(handler)` | `async_api/_generated.py:1304-1327` | Overrides default forwarding of closure; handler must then forward it. Avoid adding one merely for observation. |
| HTTP `Page.route` | `async_api/_generated.py:9799-9883` | Await registration; matching requests stall until continued/fulfilled/aborted. Service-worker requests can bypass it; docs recommend `service_workers='block'`. Enabling HTTP routing disables HTTP cache (9864). |
| HTTP `Route.abort` / `continue_` | `async_api/_generated.py:691-718`, `947-1007` | Await abort for blocked future polling; continue without overrides forwards the request. `continue_` skips other matching handlers (979-980); `fallback` continues the handler chain. |
| HTTP `Page.unroute(url, handler)` | `async_api/_generated.py:9886-9912` | Removes routes created by `Page.route`; exact matcher/handler can identify the adapter's registration. Omitting handler removes all HTTP routes for URL. |
| `Page.unroute_all(behavior=...)` | `async_api/_generated.py:9958-9979` | Documents HTTP route/HAR removal only; default does not await running handlers, `wait` does, `ignoreErrors` hides late handler errors. It is not a WebSocket unroute. |

Sync public signatures corroborate the distinction: `sync_api/_generated.py:1217-1257` exposes synchronous `close` via `_sync`, and synchronous `connect_to_server`; `9926-9957` exposes `route_web_socket`. An async adapter must use async API semantics above.

## Handler return, forwarding and persistence

- Python `P/_impl/_page.py:716-723` inserts each WS handler into `_web_socket_routes` and updates WS patterns. `_on_web_socket_route:320-332` selects the first matching page handler; absent one, it falls through to context routing. `P/_impl/_browser_context.py:266-278` selects its first match, or calls `connect_to_server()` when none matches. Normal registration remains active for future WS creation after a handler returns; this is not a one-shot route.
- `P/_impl/_network.py:794-798` calls the handler, awaits it when its result is a coroutine, then calls `_after_handle`. Use a normal `async def` handler for bounded async work; do not assume arbitrary Task/Future return values are awaited by this implementation.
- `_after_handle:744-754`: connected routes return immediately. An unconnected route receives `ensureOpened`, intentionally allowing a mock socket to open without an upstream. **Returning without connect/close is not rejection.** For a blocked attempt, explicitly await public `route.close`; do not merely return or hold the handler asleep. The generated mock's `_ensureOpened:287-299` opens only CONNECTING state, so a CLOSED wrapper is not reopened by the subsequent ensureOpened call.
- `connect_to_server:705-715` marks connected, schedules channel `connect` with `asyncio.create_task`, and returns the server-side facade. Its return is not upstream handshake completion. A duplicate call raises `Already connected to the server`.
- Automatic forwarding implementation: `_network.py:653-675` relays page/server messages when no corresponding custom message handler exists; `677-691` relays close events by default. Relay sends use scheduled helper tasks (`568-577`) that catch exceptions. Thus neither route-handler return nor the synchronous connect return is a delivery acknowledgement or proof that all internal forwarding work settled.
- Callable URL predicates produce broad driver patterns (`_network.py:768-788`) and are subsequently evaluated locally (`791-792`). A narrow predicate does not mean only that URL ever encounters installed wrapper machinery. Retain the strict origin/path/EIO/transport check required by the spec; do not infer native timing for other sockets.

## Wrapper installation and close semantics

Let **M** be `P/driver/package/lib/generated/webSocketMockSource.js` and **W** be `P/driver/package/lib/server/dispatchers/webSocketRouteDispatcher.js`.

- `P/driver/package/lib/server/dispatchers/pageDispatcher.js:174-177` installs the WS init script once when WS patterns become nonempty. `W:67-110` exposes the binding and injects M into the target. M captures `const NativeWebSocket = globalThis.WebSocket` at **93**; defines a class extending **EventTarget**, not NativeWebSocket, at **114**; and assigns a replacement global `WebSocket` class at **329-330**. An application socket can therefore pass `instanceof globalThis.WebSocket` while being a wrapper.
- M:139-144 notifies the binding of every wrapper creation. W:75-88 selects page/context matching; nonmatching connections receive `passthrough`. M:263-265 still uses the wrapper while opening its private native upstream. This is an explicit instrumentation scope, not unmodified native-global identity.
- M:195-205 and 236-255 show binding-based serialization/forwarding for routed messages, buffering before upstream OPEN, then re-dispatch into the wrapper. Message/handshake timing is affected by this routing path; no latency equivalence to an uninstrumented connection follows.
- **Page object's public wrapper close** (the Task 5 current `engine.transport.ws.close` trigger) is M:207-215. It checks code 1000 or 3000..4999, moves OPEN/CONNECTING to CLOSING, and emits `onClosePage` with `wasClean:true` for a routed socket. Default Python close forwarding then requests upstream closure. M:267-273 calls native upstream close if one exists; native upstream close events subsequently flow through M:247-249 and 301-305. This initial wrapper operation is not a captured original-native invocation, even where the later upstream event supplies native metadata.
- **Python public route.close** (for future blocked attempts) is `_network.py:697-703`: it requests `closePage` with **`wasClean:True`** and catches exceptions. W:133-141 forwards that request into the frame and also catches frame-evaluation errors. M:275-284 marks CLOSED and dispatches a **constructed `CloseEvent`** containing supplied code/reason/wasClean; it notifies close forwarding. If no upstream was connected, M:267-270 propagates the close without creating one.
- Therefore `await route.close()` success is not a proof of peer close receipt, upstream disconnection or native close-event provenance. Clean metadata may be synthetic. Neither the intentionally induced native code-1000 close nor the routed close is a natural abnormal WS1006 outage.
- These private implementation details were only read to establish limits. Task 5 must not access `_ws`, `__pwWebSocketDispatch`, the captured private constructor or any other private upstream to perform the stimulus.

## Disarm and ownership boundary

- No public `unroute_web_socket` was found in the installed async or sync generated Python APIs (bounded text search). More concretely, `_page.py:688-714,730-734` removes/stops only `_routes`; `_web_socket_routes` is separate. Context has the same separation (`_browser_context.py:437-478`). HTTP unroute therefore cannot promise to remove WS routing or restore global WebSocket.
- HTTP unroute matches the saved URL and handler (`_page.py:693-698`); preserve those exact adapter references. Public wrapping caches callable wrappers (`_async_base.py:71-76`, `_impl_to_api_mapping.py:120-142`), supporting reuse of the original callable identity. Default unroute does not wait on active handler work; own/settle that work explicitly as the existing contract requires.
- The approved routed disarm boundary is to clear the block flag/deadline and leave WS routes forwarding for the rest of this owned page/context lifetime; remove only the exact owned HTTP route, then close the owned context/browser via the existing lifecycle. Do not claim disarm restores native globals. M has no public restoration operation; the dispatcher's internal uninstall only disposes binding/init-script (`W:112-119`), and is not an adapter API.
- Page disposal internals may uninstall a WS init script (`pageDispatcher.js:360-371`); frame navigation/detach/page close/crash can emit synthetic clean close observations (`W:47-59,146-150`). Neither is evidence of a remote peer clean close or an owned browser process actually exiting. Public browser/lifecycle completion must retain the separate existing process-exit limitations.

## Required evidence meaning and narrow unsupported assumptions

The installed static code supports the spec's route separation: baseline/continuity have no adapter or routes; within-grace uses a fresh route-free original-constructor/original-prototype-close capture, unchanged-reference checks and exactly the current engine object; after-grace explicitly uses the public wrapper and supported routing for its full baseline/outage/recovery. Static inspection alone cannot establish a particular live page's original-native provenance, exact target, server grace timing, successful cleanup, actual upstream close or recovery. Those require the prescribed fake tests and separately authorized runtime evidence.

Keep scope immutable: baseline/continuity `native-passive-continuity`; within-grace `ordinary-functional-native-direct-close`; after-grace `ordinary-functional-playwright-routed-stimulus`; all summaries retain `nativeAfterGraceQualification:'NOT_RUN'`. A routed PASS cannot establish native after-grace performance, natural1006 recovery, arbitrary network-outage coverage or uninstrumented latency. `instanceof` is only one check against an independently captured original in the route-free scenario, never sufficient native provenance by itself.

No assumptions are made that public close awaits network settlement, HTTP unroute removes WS routes, callable URL matching avoids the global wrapper, handler return cancels a future socket, APIs imply installed-browser availability, or source metadata proves runtime import/execution. No CDP/private-API alternative is suggested.

## SHA-256 manifest

Paths below are exact under the explicitly defined roots; hashes were computed with local `shasum -a 256`.

| Root-relative path | SHA-256 |
|---|---|
| repo/.superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-5-brief.md | `f0705f651787a65dede2e21d0ed0de0917b63cb97b9d9b457fc1428eacdfaab5` |
| repo/docs/superpowers/specs/2026-10-18-guarded-ordinary-recovery-design.md | `0e441f9d735a219e059103c155b8b1de3f907c7d9d7b4441ec5d7b061434f411` |
| D/METADATA | `3abe20563b391c119b043b9907742241366bedf2bc2717d26d30a87c31804cb5` |
| D/RECORD | `50c419ad2775b87794f45bff1d3c6a40e86b333be7fdd08a40d72ede0275598c` |
| P/_repo_version.py | `004689044d8fef8e1f155c5b25a821781880ec99107048599758d08582b07a27` |
| P/async_api/_generated.py | `3900e98a4d41d18d041333fcbe0173267e42683be3f7106b083a8f2d841a1976` |
| P/sync_api/_generated.py | `c41c8ed5c0d70d0294e213ac0ad292f7b7236dcbc25fc5907d42b2759b472860` |
| P/_impl/_driver.py | `9a15469de4b0e15773169d32df12a2a694298a8b03ee68655c504532a27d4eaa` |
| P/_impl/_network.py | `3507c7565ad716637661e867fc7b46b45172879bac13057734b6557dfe78880b` |
| P/_impl/_page.py | `8304a370ea11736dadbbe451b887836af3e07f541954a174dcffd191e7a744af` |
| P/_impl/_browser_context.py | `7fe7afdda633621f46a2fbee9d2d72a8f1c3de431e1d8f9229c56a84f408a21a` |
| P/_impl/_async_base.py | `11d3ac217e1c6df2bba4da15e2a58ad4e6845b51ab983e7701c3592d22b941f7` |
| P/_impl/_impl_to_api_mapping.py | `86dc40006a97ee2f1129b721142b92b86c90377974fb5703be884d68fb743839` |
| P/driver/package/lib/generated/webSocketMockSource.js | `9f3f74d671223b5b312083670f686c7b23948a8cc47de14fc4f303a75d019375` |
| P/driver/package/lib/server/dispatchers/webSocketRouteDispatcher.js | `7e973b5cec6ab87f5a3c0dc1684b997a70d9d656aa8d3abed10704cbdee70b29` |
| P/driver/package/lib/server/dispatchers/pageDispatcher.js | `eccc0ce018eb6c8dc04b9ba495303fa88f6f1f7d560bec14082a7c06d7a526ba` |
| P/driver/package/lib/client/network.js | `f4af0d2bc3bf0c57a55965480702e3d7e1fa750c444afce117631f97b337e1db` |
| P/driver/package/package.json | `d4b8727c495ff2632084e922ee1c7f19a608ed23d86e8f3b0ba0ff317eea58ec` |
