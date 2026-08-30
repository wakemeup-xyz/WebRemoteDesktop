# Module State Owners

Generated: 2026-08-30T06:27:34.391Z

This is a static inventory. Counts identify likely mutable state owners; they are not runtime proof.

## web-client/js/webrtc.js

| Field | References |
| --- | ---: |
| `this.pc` | 165 |
| `this.socket` | 84 |
| `this.networkMode` | 78 |
| `this.serverConfig` | 74 |
| `this.controlState` | 53 |
| `this.currentConnectionAttemptId` | 41 |
| `this.updateNetworkUI` | 32 |
| `this.uiPhase` | 30 |
| `this.manualDisconnect` | 25 |
| `this.renderPortSearchStatus` | 21 |
| `this._dcTimeout` | 20 |
| `this.inputChannel` | 20 |
| `this.setUiPhase` | 20 |
| `this.portSearchController` | 19 |
| `this._dcReconnectTimer` | 18 |
| `this._disconnectedTimer` | 18 |
| `this._iceDisconnectedTimer` | 18 |
| `this.offerInProgress` | 17 |
| `this.reconnectTimer` | 17 |
| `this.tunnelRelayActive` | 17 |
| `this.isPortSearchActive` | 16 |
| `this.mediaActivityRuntime` | 15 |
| `this.selectedTurnServerId` | 15 |
| `this._stableResetTimer` | 14 |
| `this.hasActiveControl` | 14 |
| `this.hasPaintedFrame` | 14 |
| `this._mediaResumeRefreshFallbackUsed` | 13 |
| `this._refreshing` | 13 |
| `this.activeLeaseEnvelope` | 13 |
| `this._mediaResumeArmPending` | 12 |
| `this.inputMoveChannel` | 12 |
| `this.refresh` | 12 |
| `this.syncDesktopInputGate` | 12 |
| `WebRTC._operatorToolsState` | 12 |
| `this._latencySyncInterval` | 11 |
| `this._offerEpoch` | 11 |
| `this._portSearchRoundTimer` | 11 |
| `this.setFailureRecommendation` | 11 |
| `this._autoFailCount` | 10 |
| `this._mediaIntent` | 10 |
| `this._portSearchGeneration` | 10 |
| `this.getMediaActivitySnapshot` | 10 |
| `this.linkQualityController` | 10 |
| `this.mediaActivityController` | 10 |
| `this.tunnelPendingObjectUrl` | 10 |
| `this._statsSampler` | 9 |
| `this._superseded` | 9 |
| `this._videoFrameSeq` | 9 |
| `this.currentResolution` | 9 |
| `this.freezeControl` | 9 |
| `this.hasTurnConfigured` | 9 |
| `this.noMediaTicks` | 9 |
| `this.replayMediaActivityIntent` | 9 |
| `this.scheduleReconnect` | 9 |
| `this.stopPortSearch` | 9 |
| `this._iceRestartAttempts` | 8 |
| `this._mediaResumeFramePending` | 8 |
| `this._refreshSettleTimer` | 8 |
| `this.adaptiveResolutionEnabled` | 8 |
| `this.clearMediaResumeFallback` | 8 |
| `this.getMediaAppliedPhase` | 8 |
| `this.networkModes` | 8 |
| `this.selectedCandidatePair` | 8 |
| `this.updateControlUI` | 8 |
| `this._lastInboundFramesDecoded` | 7 |
| `this._mediaReadyConnectionAttemptId` | 7 |
| `this._networkAdvisorPinned` | 7 |
| `this._noRelayReceiveCount` | 7 |
| `this._portSearchRefreshOwned` | 7 |
| `this._portSearchRetryTimer` | 7 |
| `this.clearFailureRecommendation` | 7 |
| `this.connectionAttemptSequence` | 7 |
| `this.initializeSessionCoordinator` | 7 |
| `this.isMediaHealthSuppressed` | 7 |
| `this.lastCandidateType` | 7 |
| `this.sessionCoordinator` | 7 |
| `WebRTC._retryOperatorTools` | 7 |
| `this._deferPeerUntilConfig` | 6 |
| `this._explicitOverride1080` | 6 |
| `this._mediaResumeBaseline` | 6 |

### Event/order notes

- Facade methods and public event names remain compatibility boundaries.
- Runtime verification must cover first frame, input, relay, lease transitions, and shutdown.

## python-host/host.py

| Field | References |
| --- | ---: |
| `self.pc` | 29 |
| `self.sio` | 27 |
| `self.relay_streamer` | 22 |
| `self.input_handler` | 17 |
| `self.screen_track` | 17 |
| `self.current_viewer_id` | 15 |
| `self._suspended` | 14 |
| `self._capture_running` | 12 |
| `self._activity_condition` | 11 |
| `self.profile_name` | 11 |
| `self._media_activity_suspended` | 10 |
| `self._offer_epoch` | 10 |
| `self.proc` | 10 |
| `self._active_input_binding` | 9 |
| `self.inflight_frames` | 9 |
| `self.max_in_flight_frames` | 9 |
| `self.suspended` | 9 |
| `self.viewer_id` | 9 |
| `self._max_height` | 8 |
| `self._max_width` | 8 |
| `self._timing_totals` | 8 |
| `self.ack_event` | 8 |
| `self.good_ack_streak` | 8 |
| `self.jpeg_quality` | 8 |
| `self.last_ack_latency_ms` | 8 |
| `self.media_sender` | 8 |
| `self.production_generation` | 8 |
| `self.stats_frames` | 8 |
| `self._capture_seq` | 7 |
| `self._last_img` | 7 |
| `self.monitor` | 7 |
| `self.task` | 7 |
| `self._connection_generation` | 6 |
| `self._input_datachannel` | 6 |
| `self.frame_count` | 6 |
| `self.frame_id` | 6 |
| `self.height` | 6 |
| `self.pending_candidates` | 6 |
| `self.width` | 6 |
| `self._capture_buffer` | 5 |
| `self._capture_thread` | 5 |
| `self._last_diag_network` | 5 |
| `self._media_activity_binding` | 5 |
| `self._target_lock` | 5 |
| `self._timing_count` | 5 |
| `self._total_reuse` | 5 |
| `self.enabled` | 5 |
| `self.fps` | 5 |
| `self.last_acked_frame_id` | 5 |
| `self.media_profile` | 5 |
| `self.sct` | 5 |
| `self.stats_ack_latency_ms` | 5 |
| `self.stats_ack_samples` | 5 |
| `self.stats_acked` | 5 |
| `self.stats_bytes` | 5 |
| `self.stats_encode_ms` | 5 |
| `self.stats_started_at` | 5 |
| `self.stats_timeout_count` | 5 |
| `self._apply_profile` | 4 |
| `self._capture_lock` | 4 |
| `self._close_peer_connection` | 4 |
| `self._frame_interval` | 4 |
| `self._input_move_datachannel` | 4 |
| `self._last_frame_time` | 4 |
| `self._pending_input_data` | 4 |
| `self._pending_input_ids` | 4 |
| `self._reconnecting` | 4 |
| `self._reset_keyboard_lifecycle` | 4 |
| `self._reuse_count` | 4 |
| `self._session_turn_server_id` | 4 |
| `self._set_user_resolution` | 4 |
| `self._user_resolution` | 4 |
| `self.last_time` | 4 |
| `self.overlay` | 4 |
| `self.pending_frame_count` | 4 |
| `self._input_lifecycle_tasks` | 3 |
| `self._last_consumed_seq` | 3 |
| `self._pending_input_lock` | 3 |
| `self._process_executor` | 3 |
| `self._profile_index` | 3 |

### Event/order notes

- Facade methods and public event names remain compatibility boundaries.
- Runtime verification must cover first frame, input, relay, lease transitions, and shutdown.

## signal-server/websocket/signaling.js

| Field | References |
| --- | ---: |
| `connections.host` | 59 |
| `connections.viewers` | 24 |
| `connections.relayViewers` | 5 |
| `hostCapabilities` | 3 |

### Event/order notes

- Facade methods and public event names remain compatibility boundaries.
- Runtime verification must cover first frame, input, relay, lease transitions, and shutdown.
