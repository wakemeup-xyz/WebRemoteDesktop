const WebRTC = {
  pc: null,
  socket: null,
  relaySocket: null,
  remoteStream: null,
  statsTimer: null,
  offerInProgress: false,
  _offerEpoch: 0,
  videoTransceiver: null,
  reconnectTimer: null,
  manualDisconnect: false,
  _refreshing: false,
  inputChannel: null,
  inputMoveChannel: null,
  serverConfig: null,
  networkMode: localStorage.getItem('wrdNetworkMode') || 'auto',
  useRelayFallback: false,
  tunnelRelayActive: false,
  tunnelFrameCount: 0,
  tunnelStartedAt: 0,
  tunnelLastObjectUrl: '',
  tunnelPendingObjectUrl: '',
  tunnelLastFrameId: 0,
  currentResolution: { width: 960, height: 540, label: '540p' },
  noMediaTicks: 0,
  lastCandidateType: '',
  _autoFailCount: 0,
  _iceRestartAttempts: 0,
  _tunnelLockUntil: 0,
  selectedCandidatePair: null,
  candidateSummary: {
    local: { host: 0, srflx: 0, relay: 0, prflx: 0, other: 0 },
    remote: { host: 0, srflx: 0, relay: 0, prflx: 0, other: 0 },
    samples: { local: [], remote: [] }
  },
  
  config: {
    iceServers: []
  },

  networkModes: {
    lan: {
      label: '本地直连',
      state: '最低延迟',
      hint: '访问电脑和这台 Mac 在同一局域网时使用。失败时切换到自动穿透或外网中继。'
    },
    auto: {
      label: '自动穿透',
      state: '推荐',
      hint: '默认模式。优先低延迟直连；配置 TURN 时失败后可自动改走中继；未配置 TURN 时仍先尝试直连，失败后按恢复逻辑处理。'
    },
    stun: {
      label: '外网直连',
      state: '看网络',
      hint: '适合外网但 UDP 未被限制的环境。连接失败 2 次后自动切换隧道中继兜底。'
    },
    relay: {
      label: '外网中继',
      state: '最稳',
      hint: '适合公司网、校园网、跨运营商、蜂窝热点或 ICE 失败场景。需要服务端配置 TURN。'
    },
    tunnel: {
      label: '隧道中继',
      state: '兜底',
      hint: 'TURN 也失败时使用。视频通过 Cloudflare/Socket.IO 转发，FPS 较低但不依赖 UDP。'
    }
  },

  hasTurnConfigured() {
    return this.getTurnServers().length > 0;
  },

  isPublicOrigin() {
    let hostname = String(window.location?.hostname || '').toLowerCase();
    if (!hostname) {
      const origin = String(window.location?.origin || '').toLowerCase();
      const match = origin.match(/^[a-z]+:\/\/([^/:?#]+)/);
      hostname = match ? match[1] : '';
    }
    if (!hostname) {
      return false;
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return false;
    }
    if (hostname.endsWith('.local')) {
      return false;
    }
    return true;
  },

  enforceSupportedNetworkMode(preferredMode = this.networkMode) {
    if (preferredMode === 'relay' && !this.hasTurnConfigured()) {
      console.warn('[NETWORK] Relay mode requested without TURN; forcing tunnel mode');
      this.networkMode = 'tunnel';
      localStorage.setItem('wrdNetworkMode', 'tunnel');
      return {
        effectiveMode: 'tunnel',
        changed: true,
        reason: this.serverConfig?.turnStatus === 'misconfigured'
          ? 'TURN 配置不完整，无法使用外网中继，已切换到隧道中继。'
          : '当前未配置 TURN，无法使用外网中继，已切换到隧道中继。',
      };
    }
    this.networkMode = preferredMode;
    localStorage.setItem('wrdNetworkMode', preferredMode);
    return { effectiveMode: preferredMode, changed: false, reason: '' };
  },
  
  async init() {
    const token = Auth.getToken();
    if (!token) {
      console.error('No token available');
      return;
    }
    this.manualDisconnect = false;
    await this.loadServerConfig();
    const modeState = this.enforceSupportedNetworkMode(this.networkMode);
    this.configureNetworkControls();
    this.updateNetworkUI(modeState.changed ? modeState.reason : '网络模式已就绪', modeState.changed ? 'warning' : '');

    const socketBase = (typeof RuntimeConfig !== 'undefined')
      ? RuntimeConfig.getSocketBase()
      : window.location.origin;
    this.socket = io(socketBase, {
      auth: { token, role: 'viewer' }
    });

    this.setupSocketListeners();
    if (this.networkMode === 'tunnel') {
      this.startTunnelRelay();
      return;
    }
    this.createPeerConnection();
  },

  async loadServerConfig() {
    try {
      const token = Auth.getToken();
      const apiBase = (typeof RuntimeConfig !== 'undefined')
        ? RuntimeConfig.getApiBase()
        : '';
      const response = await fetch(`${apiBase}/api/webrtc-config`, {
        cache: 'no-store',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.serverConfig = await response.json();
      console.log('[NETWORK] Loaded WebRTC config:', {
        stunUrls: this.serverConfig.stunUrls,
        turnConfigured: this.serverConfig.turnConfigured,
        turnUrls: this.serverConfig.turnUrls
      });
    } catch (err) {
      console.warn('[NETWORK] Failed to load WebRTC config, using built-in STUN only:', err);
      this.serverConfig = {
        stunUrls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
        turnConfigured: false,
        turnUrls: [],
        iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
      };
    }
  },

  getStunServers() {
    const defaultUrls = [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ];
    const stunUrls = this.serverConfig?.stunUrls?.length
      ? this.serverConfig.stunUrls
      : defaultUrls;
    const deduped = [...new Set((stunUrls || [])
      .map((url) => String(url || '').trim())
      .filter(Boolean))];
    return deduped.length ? [{ urls: deduped }] : [];
  },

  getTurnServers() {
    if (!this.serverConfig?.turnConfigured) {
      return [];
    }
    return (this.serverConfig.iceServers || []).filter((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url) => String(url).startsWith('turn:') || String(url).startsWith('turns:'));
    });
  },

  buildPeerConfig() {
    const turnServers = this.getTurnServers();
    let iceServers = [];
    let iceTransportPolicy = 'all';

    if (this.networkMode === 'lan') {
      iceServers = [];
    } else if (this.networkMode === 'stun') {
      iceServers = this.getStunServers();
    } else if (this.networkMode === 'relay') {
      iceServers = turnServers;
      iceTransportPolicy = 'relay';
    } else if (this.useRelayFallback && turnServers.length) {
      iceServers = turnServers;
      iceTransportPolicy = 'relay';
    } else {
      iceServers = [...this.getStunServers(), ...turnServers];
    }

    return {
      iceServers,
      iceTransportPolicy,
      iceCandidatePoolSize: this.networkMode === 'lan' ? 0 : 4,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    };
  },

  resetCandidateSummary() {
    this.candidateSummary = {
      local: { host: 0, srflx: 0, relay: 0, prflx: 0, other: 0 },
      remote: { host: 0, srflx: 0, relay: 0, prflx: 0, other: 0 },
      samples: { local: [], remote: [] }
    };
  },

  parseCandidate(candidateLike) {
    const candidateString = typeof candidateLike === 'string'
      ? candidateLike
      : candidateLike?.candidate || '';
    if (!candidateString) {
      return null;
    }
    const raw = candidateString.startsWith('candidate:')
      ? candidateString.slice(10)
      : candidateString;
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 8) {
      return null;
    }
    const typeIndex = parts.indexOf('typ');
    const candidateType = typeIndex >= 0 && parts[typeIndex + 1] ? parts[typeIndex + 1] : 'other';
    return {
      type: candidateType,
      protocol: (parts[2] || '').toLowerCase(),
      address: `${parts[4] || '?'}:${parts[5] || '?'}`,
    };
  },

  detectAddressFamily(address = '') {
    const host = String(address).replace(/^\[/, '').split(']')[0].split(':')[0];
    if (String(address).includes(':') && !/^\d+\.\d+\.\d+\.\d+/.test(String(address))) {
      return 'ipv6';
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      return 'ipv4';
    }
    return address ? 'hostname' : '';
  },

  classifyCandidateHealth(snapshot = this.collectNetworkSnapshot()) {
    const summary = snapshot.candidateSummary || {};
    const local = summary.local || {};
    const remote = summary.remote || {};
    const hasRelay = Number(local.relay || 0) > 0 || Number(remote.relay || 0) > 0;
    const hasSrflx = Number(local.srflx || 0) > 0 || Number(remote.srflx || 0) > 0;
    const hasRemote = ['host', 'srflx', 'relay', 'prflx'].some((type) => Number(remote[type] || 0) > 0);
    if (!snapshot.turnConfigured && !hasRelay && hasSrflx) {
      return hasRemote ? 'stun-no-turn-no-relay' : 'stun-local-only-no-turn';
    }
    if (hasRelay) {
      return 'relay-candidate-present';
    }
    if (!hasSrflx && !hasRemote) {
      return 'no-usable-candidates';
    }
    return 'candidate-check-needed';
  },

  addCandidateSample(direction, candidateLike) {
    const parsed = this.parseCandidate(candidateLike);
    if (!parsed) {
      return;
    }
    const bucket = ['host', 'srflx', 'relay', 'prflx'].includes(parsed.type) ? parsed.type : 'other';
    const summary = this.candidateSummary?.[direction];
    const samples = this.candidateSummary?.samples?.[direction];
    if (!summary || !samples) {
      return;
    }
    summary[bucket] = (summary[bucket] || 0) + 1;
    if (samples.length < 6) {
      samples.push(parsed);
    }
  },

  collectNetworkSnapshot() {
    return {
      networkMode: this.networkMode || null,
      useRelayFallback: Boolean(this.useRelayFallback),
      tunnelRelayActive: Boolean(this.tunnelRelayActive),
      tunnelLockUntil: Number(this._tunnelLockUntil || 0),
      autoFailCount: Number(this._autoFailCount || 0),
      iceRestartAttempts: Number(this._iceRestartAttempts || 0),
      noMediaTicks: Number(this.noMediaTicks || 0),
      lastCandidateType: this.lastCandidateType || '',
      turnConfigured: Boolean(this.serverConfig?.turnConfigured),
      turnStatus: this.serverConfig?.turnStatus || 'unknown',
      selectedCandidatePair: this.selectedCandidatePair,
      candidateSummary: this.candidateSummary,
      pc: this.pc ? {
        connectionState: this.pc.connectionState || null,
        iceConnectionState: this.pc.iceConnectionState || null,
        iceGatheringState: this.pc.iceGatheringState || null,
        signalingState: this.pc.signalingState || null,
      } : null,
    };
  },
  
  setupSocketListeners() {
    this.socket.on('connect', () => {
      console.log('[OFFER-DBG] Socket connect: offerInProgress=%s pc=%s pcState=%s',
        this.offerInProgress, !!this.pc, this.pc?.connectionState);
      updateConnectionStatus('connecting');
      // Reset offerInProgress on reconnect to prevent stuck state
      if (this.offerInProgress) {
        console.warn('[OFFER-DBG] Resetting stuck offerInProgress on reconnect');
        this.offerInProgress = false;
      }
      if (!this.pc || ['failed', 'closed'].includes(this.pc.connectionState)) {
        this.createPeerConnection();
        console.log('[OFFER-DBG] Created new PC on reconnect, pcState=%s', this.pc?.connectionState);
      }
    });

    this.socket.on('connected', (data) => {
      console.log('[OFFER-DBG] Connected event: hostOnline=%s offerInProgress=%s pc=%s pcState=%s',
        data.hostOnline, this.offerInProgress, !!this.pc, this.pc?.connectionState);

      if (data.hostOnline) {
        this.createOffer();
      } else {
        updateLoadingText('等待Host上线...');
      }
    });

    this.socket.on('host-status', (data) => {
      console.log('[OFFER-DBG] host-status event: online=%s offerInProgress=%s pc=%s',
        data.online, this.offerInProgress, !!this.pc);
      if (data.online) {
        updateLoadingText('Host已上线，正在连接...');
        if (!this.pc || ['failed', 'closed'].includes(this.pc.connectionState)) {
          this.createPeerConnection();
        }
        // Force a new offer if the previous one is stuck
        if (this.offerInProgress) {
          console.warn('[NETWORK] Host came online but offerInProgress=true; forcing new offer');
          this.offerInProgress = false;
        }
        this.createOffer();
      } else {
        updateConnectionStatus('disconnected');
        updateLoadingText('Host已离线');
      }
    });

    this.socket.on('answer', async (data) => {
      console.log('Received answer');
      if (!this.pc || this.pc.signalingState !== 'have-local-offer') {
        console.warn('[NETWORK] Ignoring stale answer: pc=%s, signalingState=%s',
          !!this.pc, this.pc?.signalingState);
        return;
      }
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      } catch (err) {
        console.error('Failed to set remote description:', err);
      }
    });

    this.socket.on('ice-candidate', async (data) => {
      if (!this.pc || this.pc.signalingState === 'closed') {
        console.warn('[NETWORK] Ignoring ICE candidate: no active PC');
        return;
      }
      try {
        this.addCandidateSample('remote', data.candidate);
        await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('Failed to add ICE candidate:', err);
      }
    });

    this.socket.on('disconnect', () => {
      console.log('Signaling disconnected');
      updateConnectionStatus('disconnected');
      document.getElementById('remoteVideo').classList.remove('connected');
    });

    this.socket.on('relay-frame', (data) => {
      this.handleRelayFrame(data);
    });
  },
  
  createPeerConnection() {
    if (this.networkMode === 'tunnel') {
      return;
    }
    this.config = this.buildPeerConfig();
    this.resetCandidateSummary();
    this.noMediaTicks = 0;
    this.lastCandidateType = '';
    this.selectedCandidatePair = null;
    if (this._dcTimeout) { clearTimeout(this._dcTimeout); this._dcTimeout = null; }
    this.pc = new RTCPeerConnection(this.config);
    this.videoTransceiver = null;
    this.inputChannel = null;
    this.inputMoveChannel = null;

    console.log('Creating RTCPeerConnection with config:', this.config);
    this.updateNetworkUI('正在建立媒体链路...');
    this.createInputChannel();

    this.pc.onicecandidate = (event) => {
      console.log('Viewer ICE candidate:', event.candidate);
      if (event.candidate) {
        this.addCandidateSample('local', event.candidate);
        this.socket.emit('ice-candidate', {
          target: 'host',
          candidate: event.candidate
        });
      }
    };

    this.pc.onicegatheringstatechange = () => {
      console.log('Viewer ICE gathering state:', this.pc.iceGatheringState);
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log('Viewer ICE connection state:', this.pc.iceConnectionState);
      if (this._refreshing) return;
      if (this.pc.iceConnectionState === 'disconnected') {
        // Disconnected is often temporary; wait 5s for auto-recovery before forcing reconnect
        if (this._iceDisconnectedTimer) return;
        console.warn('[RECOVERY] ICE disconnected, waiting 5s for auto-recovery...');
        this._iceDisconnectedTimer = setTimeout(() => {
          this._iceDisconnectedTimer = null;
          if (this.pc && this.pc.iceConnectionState === 'connected') {
            console.log('[RECOVERY] ICE recovered, skipping reconnect');
            return;
          }
          this.scheduleReconnect('ice-disconnected');
        }, 5000);
      } else if (['failed', 'closed'].includes(this.pc.iceConnectionState)) {
        this.scheduleReconnect(`ice-${this.pc.iceConnectionState}`);
      }
    };

    this.pc.onconnectionstatechange = () => {
      console.log('Viewer Connection state:', this.pc.connectionState);
      if (this._refreshing) return;
      if (this.pc.connectionState === 'connected') {
        // Cancel any pending disconnected-recovery timers
        if (this._disconnectedTimer) {
          clearTimeout(this._disconnectedTimer);
          this._disconnectedTimer = null;
          console.log('[RECOVERY] PC recovered from disconnected, canceling scheduled reconnect');
        }
        if (this._iceDisconnectedTimer) {
          clearTimeout(this._iceDisconnectedTimer);
          this._iceDisconnectedTimer = null;
          console.log('[RECOVERY] ICE recovered from disconnected, canceling scheduled reconnect');
        }
        console.log('WebRTC connected, initializing input...');
        // Start stats ASAP — before any other init that could throw
        this.startStats();
        this.updateNetworkUI('媒体链路已连接');
        this._autoFailCount = 0;
        this._iceRestartAttempts = 0;

        // Safety net: hide loading spinner (primary hide is in ontrack via video events)
        const loadingEl = document.getElementById('loading');
        if (loadingEl && !loadingEl.classList.contains('hidden')) {
          console.log('[LOADING] Hiding spinner from connectionstatechange (safety net)');
          loadingEl.classList.add('hidden');
          document.body.classList.add('stream-connected');
          updateConnectionStatus('connected');
          const videoEl = document.getElementById('remoteVideo');
          if (videoEl) videoEl.classList.add('connected');
        }
        // Stop tunnel relay if it was running (auto fallback case)
        if (this.tunnelRelayActive) {
          console.log('[NETWORK] WebRTC connected, stopping tunnel relay');
          this.stopTunnelRelay();
        }
        if (typeof Input !== 'undefined') {
          Input.init();
          Input.setActive(true);
        }
        // Hook requestVideoFrameCallback for latency measurement
        const video = document.getElementById('remoteVideo');
        if (video && typeof video.requestVideoFrameCallback === 'function') {
          const onFrame = (now, metadata) => {
            if (typeof LatencyMonitor !== 'undefined') {
              LatencyMonitor.onVideoFrame(now, metadata);
            }
            video.requestVideoFrameCallback(onFrame);
          };
          video.requestVideoFrameCallback(onFrame);
        }
        // Playout buffer is already estimated via requestVideoFrameCallback in LatencyMonitor.onVideoFrame
        // No need for a redundant setInterval here
        // Start latency clock sync after connection is stable
        setTimeout(() => {
          if (typeof LatencyMonitor !== 'undefined') {
            LatencyMonitor.requestClockSync();
            // Re-sync every 30 seconds
            if (!this._latencySyncInterval) {
              this._latencySyncInterval = setInterval(() => {
                if (typeof LatencyMonitor !== 'undefined') {
                  LatencyMonitor.requestClockSync();
                }
              }, 30000);
            }
          }
        }, 2000);
      } else if (['failed', 'disconnected', 'closed'].includes(this.pc.connectionState)) {
        if (typeof Input !== 'undefined') {
          Input.setActive(false);
        }
        if (this._latencySyncInterval) {
          clearInterval(this._latencySyncInterval);
          this._latencySyncInterval = null;
        }
        // _playoutEstimateInterval removed: playout buffer is tracked via requestVideoFrameCallback only
        this.updateNetworkUI('媒体链路失败，请按浮窗建议切换网络模式', 'danger');
        if (this.pc.connectionState === 'disconnected') {
          if (this._disconnectedTimer) return;
          console.warn('[RECOVERY] PC disconnected, waiting 5s for auto-recovery...');
          this._disconnectedTimer = setTimeout(() => {
            this._disconnectedTimer = null;
            if (this.pc && this.pc.connectionState === 'connected') {
              console.log('[RECOVERY] PC recovered, skipping reconnect');
              return;
            }
            this.scheduleReconnect('pc-disconnected');
          }, 5000);
        } else {
          this.scheduleReconnect(`pc-${this.pc.connectionState}`);
        }
      }
    };

    this.pc.onsignalingstatechange = () => {
      console.log('Viewer Signaling state:', this.pc.signalingState);
    };

    this.pc.ontrack = (event) => {
      console.log('Received remote track:', event.track.kind, 'streams:', event.streams.length);
      this.remoteStream = event.streams[0];

      const videoElement = document.getElementById('remoteVideo');
      videoElement.srcObject = this.remoteStream;

      // Reduce jitter buffer aggressively for remote desktop (Chrome/Edge only)
      const receivers = this.pc.getReceivers ? this.pc.getReceivers() : [];
      receivers.forEach(receiver => {
        if (receiver.track && receiver.track.kind === 'video') {
          // playoutDelayHint (Chrome 129+): explicit min/max in seconds
          if (typeof receiver.playoutDelayHint !== 'undefined') {
            receiver.playoutDelayHint = { min: 0, max: 0.1 };
            console.log('[LATENCY] Set playoutDelayHint = {min:0, max:0.1}');
          }
          // jitterBufferTarget: hint in ms (older API, still useful as fallback)
          if (typeof receiver.jitterBufferTarget !== 'undefined') {
            receiver.jitterBufferTarget = 1;
            console.log('[LATENCY] Set jitterBufferTarget = 1');
          }
        }
      });

      videoElement.muted = true;
      videoElement.play().then(() => {
        console.log('Video playback started (promise)');
      }).catch(err => {
        console.error('Video play failed:', err);
      });

      const hideLoading = () => {
        const el = document.getElementById('loading');
        const state = `readyState=${videoElement.readyState} paused=${videoElement.paused} hasHidden=${el ? el.classList.contains('hidden') : 'no-el'}`;
        console.log('[LOADING] hideLoading called:', state);
        if (el && !el.classList.contains('hidden')) {
          console.log('Hiding loading spinner');
          el.classList.add('hidden');
          document.body.classList.add('stream-connected');
          updateConnectionStatus('connected');
          videoElement.classList.add('connected');
        } else if (el && el.classList.contains('hidden')) {
          console.log('[LOADING] Already hidden, skipping');
        }
      };

      // If metadata already loaded, hide loading immediately (race condition fix)
      if (videoElement.readyState >= 1) {
        hideLoading();
      } else {
        videoElement.onloadedmetadata = () => {
          console.log('Video metadata loaded:', videoElement.videoWidth, 'x', videoElement.videoHeight);
          hideLoading();
        };
      }

      // If already playing, hide immediately; otherwise wait for playing event
      if (!videoElement.paused) {
        hideLoading();
      }
      videoElement.onplaying = () => {
        console.log('Video is now playing');
        hideLoading();
      };

      this.remoteStream.getTracks().forEach(track => {
        console.log('Track:', track.kind, 'enabled:', track.enabled, 'state:', track.readyState);
      });

      // Last-resort fallback: if loading still visible after 8s, force hide
      setTimeout(() => {
        const el = document.getElementById('loading');
        const video = document.getElementById('remoteVideo');
        if (el && !el.classList.contains('hidden')) {
          console.warn('[LOADING] Fallback timeout triggered: force-hiding spinner. Video readyState=%s paused=%s',
            video ? video.readyState : 'no-video', video ? video.paused : 'no-video');
          el.classList.add('hidden');
          document.body.classList.add('stream-connected');
          updateConnectionStatus('connected');
          if (video) video.classList.add('connected');
        }
      }, 8000);
    };
  },

  createInputChannel() {
    if (!this.pc || this.inputChannel) {
      return;
    }

    this.inputChannel = this.pc.createDataChannel('input', {
      ordered: true
    });
    this.inputChannel.bufferedAmountLowThreshold = 32 * 1024;
    this.inputMoveChannel = this.pc.createDataChannel('input-move', {
      ordered: false,
      maxRetransmits: 0
    });
    this.inputMoveChannel.bufferedAmountLowThreshold = 4 * 1024;

    // Timeout detection: check PC state before forcing reconnect.
    // If ICE/DTLS is still in progress, extend timeout instead of cascading.
    this._dcTimeoutExtensions = 0;
    const checkDcTimeout = () => {
      if (this.inputChannel && this.inputChannel.readyState !== 'open') {
        const pcState = this.pc ? this.pc.connectionState : 'closed';
        const iceState = this.pc ? this.pc.iceConnectionState : 'closed';
        console.warn('[INPUT-DC] DataChannel stuck state=%s pc=%s ice=%s ext=%d',
          this.inputChannel.readyState, pcState, iceState, this._dcTimeoutExtensions);
        if ((pcState === 'connecting' || iceState === 'checking') && this._dcTimeoutExtensions < 2) {
          this._dcTimeoutExtensions += 1;
          this._dcTimeout = setTimeout(checkDcTimeout, 10000);
          return;
        }
        this.scheduleReconnect('dc-stuck');
      }
    };
    this._dcTimeout = setTimeout(checkDcTimeout, 10000);

    this.inputChannel.onopen = () => {
      console.log('[INPUT-DC] DataChannel open');
      if (this._dcTimeout) { clearTimeout(this._dcTimeout); this._dcTimeout = null; }
      if (typeof Input !== 'undefined') {
        Input.updateKeyDisplayRaw('输入直连已就绪');
      }
    };
    this.inputChannel.onclose = () => {
      const sctpState = this.pc && this.pc.sctp ? this.pc.sctp.state : 'no-sctp';
      console.log('[INPUT-DC] DataChannel closed, sctp=%s pc=%s ice=%s',
        sctpState,
        this.pc ? this.pc.connectionState : 'no-pc',
        this.pc ? this.pc.iceConnectionState : 'no-pc');
      if (this._dcTimeout) { clearTimeout(this._dcTimeout); this._dcTimeout = null; }
      // Defer reconnect to avoid cascading on brief DC hiccups
      if (!this._refreshing && !this.manualDisconnect && this.pc &&
          this.pc.connectionState === 'connected') {
        if (this._dcReconnectTimer) return;
        console.warn('[INPUT-DC] Unexpected close while PC connected, will reconnect in 3s if not recovered');
        this._dcReconnectTimer = setTimeout(() => {
          this._dcReconnectTimer = null;
          if (this.manualDisconnect || !this.pc || this.pc.connectionState !== 'connected') return;
          this.scheduleReconnect('dc-closed');
        }, 3000);
      }
    };
    this.inputChannel.onerror = (event) => {
      console.warn('[INPUT-DC] DataChannel error:', event);
      // Error typically precedes close; defer reconnect to avoid cascading
      if (!this._refreshing && !this.manualDisconnect && this.pc &&
          this.pc.connectionState === 'connected') {
        if (this._dcReconnectTimer) return;
        this._dcReconnectTimer = setTimeout(() => {
          this._dcReconnectTimer = null;
          if (this.manualDisconnect || !this.pc || this.pc.connectionState !== 'connected') return;
          this.scheduleReconnect('dc-error');
        }, 3000);
      }
    };
    this.inputChannel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Latency measurement messages
        if (data.type === 'frame_timing') {
          if (typeof LatencyMonitor !== 'undefined') {
            LatencyMonitor.onFrameTiming(data);
          }
          return;
        }
        if (data.type === 'clock_sync_resp') {
          if (typeof LatencyMonitor !== 'undefined') {
            LatencyMonitor.handleClockSyncResponse(data);
          }
          return;
        }
        // Host capture stats → update FPS display as fallback
        if (data.type === 'capture_stats') {
          if (data.fps !== undefined) {
            document.getElementById('fpsDisplay').textContent = `${Math.round(data.fps)} FPS`;
          }
          return;
        }
      } catch (e) {
        // Silently ignore non-JSON or unexpected messages
      }
    };
    this.inputMoveChannel.onopen = () => {
      console.log('[INPUT-DC] Move DataChannel open');
    };
    this.inputMoveChannel.onclose = () => {
      console.log('[INPUT-DC] Move DataChannel closed');
    };
    this.inputMoveChannel.onerror = (event) => {
      console.warn('[INPUT-DC] Move DataChannel error:', event);
    };
  },

  sendInput(data) {
    const isMouseMove = data.type === 'mouse' && data.action === 'move';
    const channel = isMouseMove && this.inputMoveChannel?.readyState === 'open'
      ? this.inputMoveChannel
      : this.inputChannel;

    if (!channel || channel.readyState !== 'open') {
      return false;
    }

    if (isMouseMove && channel.bufferedAmount > 4 * 1024) {
      return true;
    }

    if (!isMouseMove && channel.bufferedAmount > 512 * 1024) {
      console.warn('[INPUT-DC] Buffered amount too high, falling back to Socket.IO:', channel.bufferedAmount);
      return false;
    }

    channel.send(JSON.stringify({
      ...data,
      transport: 'datachannel'
    }));
    return true;
  },

  startTunnelRelay() {
    if (!this.socket || !this.socket.connected) {
      return;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this._tunnelLockUntil = Date.now() + 30000;
    this.tunnelRelayActive = true;
    this.tunnelFrameCount = 0;
    this.tunnelStartedAt = performance.now();
    document.body.classList.add('tunnel-relay-active');
    document.getElementById('loading')?.classList.remove('hidden');
    updateLoadingText('正在启动隧道中继...');
    updateConnectionStatus('connecting');
    this.updateNetworkUI('隧道中继正在启动。该模式走 Cloudflare/Socket.IO，不依赖 WebRTC UDP。', 'warning');
    this.ensureRelaySocket();
    if (this.relaySocket?.connected) {
      this.emitRelayStreamControl();
    }
    if (typeof Input !== 'undefined') {
      Input.init();
      Input.setActive(true);
    }
  },

  ensureRelaySocket() {
    if (this.relaySocket && this.relaySocket.connected) {
      return;
    }
    if (this.relaySocket) {
      this.relaySocket.disconnect();
      this.relaySocket = null;
    }
    const token = Auth.getToken();
    const socketBase = (typeof RuntimeConfig !== 'undefined')
      ? RuntimeConfig.getSocketBase()
      : window.location.origin;
    this.relaySocket = io(socketBase, {
      auth: { token, role: 'relay-viewer' },
      transports: ['websocket', 'polling']
    });
    this.relaySocket.on('connect', () => {
      console.log('[TUNNEL] Relay socket connected');
      if (this.tunnelRelayActive) {
        this.emitRelayStreamControl();
      }
    });
    this.relaySocket.on('relay-frame', (data) => {
      this.handleRelayFrame(data);
    });
    this.relaySocket.on('disconnect', () => {
      console.log('[TUNNEL] Relay socket disconnected');
    });
  },

  emitRelayStreamControl() {
    const width = Math.min(this.currentResolution.width || 960, 1280);
    const height = Math.min(this.currentResolution.height || 540, 720);
    const fps = width > 960 || height > 540 ? 6 : 8;
    this.relaySocket.emit('relay-stream-control', {
      enabled: true,
      width,
      height,
      fps
    });
  },

  stopTunnelRelay() {
    if (this.relaySocket && this.relaySocket.connected && this.tunnelRelayActive) {
      this.relaySocket.emit('relay-stream-control', { enabled: false });
    }
    this.tunnelRelayActive = false;
    if (this.relaySocket) {
      this.relaySocket.disconnect();
      this.relaySocket = null;
    }
    document.body.classList.remove('tunnel-relay-active');
    const relayImage = document.getElementById('relayImage');
    if (relayImage) {
      relayImage.classList.add('hidden');
      relayImage.removeAttribute('src');
    }
    if (this.tunnelLastObjectUrl) {
      URL.revokeObjectURL(this.tunnelLastObjectUrl);
      this.tunnelLastObjectUrl = '';
    }
    if (this.tunnelPendingObjectUrl) {
      URL.revokeObjectURL(this.tunnelPendingObjectUrl);
      this.tunnelPendingObjectUrl = '';
    }
  },

  handleRelayFrame(data) {
    if (!this.tunnelRelayActive) {
      return;
    }
    const relayImage = document.getElementById('relayImage');
    if (!relayImage || !data?.data) {
      return;
    }
    const frameId = Number(data.frameId || 0);
    if (frameId && frameId <= this.tunnelLastFrameId) {
      return;
    }
    this.tunnelLastFrameId = frameId || this.tunnelLastFrameId + 1;

    if (typeof data.data === 'string') {
      relayImage.src = `data:${data.mime || 'image/jpeg'};base64,${data.data}`;
    } else {
      const blob = data.data instanceof Blob
        ? data.data
        : new Blob([data.data], { type: data.mime || 'image/jpeg' });
      if (this.tunnelPendingObjectUrl) {
        URL.revokeObjectURL(this.tunnelPendingObjectUrl);
      }
      this.tunnelPendingObjectUrl = URL.createObjectURL(blob);
      relayImage.onload = () => {
        if (this.tunnelLastObjectUrl) {
          URL.revokeObjectURL(this.tunnelLastObjectUrl);
        }
        this.tunnelLastObjectUrl = this.tunnelPendingObjectUrl;
        this.tunnelPendingObjectUrl = '';
        if (this.relaySocket && this.relaySocket.connected) {
          this.relaySocket.emit('relay-frame-ack', {
            frameId: this.tunnelLastFrameId,
            renderedAt: Date.now(),
            latencyMs: data.timestamp ? Math.max(0, Date.now() - Number(data.timestamp)) : 0
          });
        }
      };
      relayImage.src = this.tunnelPendingObjectUrl;
    }
    relayImage.classList.remove('hidden');
    document.getElementById('loading')?.classList.add('hidden');
    document.body.classList.add('stream-connected');
    updateConnectionStatus('connected');
    const latencyEl = document.getElementById('latencyDisplay');
    const latency = data.timestamp ? Math.max(0, Date.now() - Number(data.timestamp)) : 0;
    if (latencyEl) {
      latencyEl.textContent = latency ? `${latency} ms` : '- ms';
    }
    const candidateEl = document.getElementById('candidateDisplay');
    if (candidateEl) {
      candidateEl.textContent = '链路 tunnel';
    }
    if (data.width && data.height) {
      document.getElementById('resolutionDisplay').textContent = `tunnel (${data.width}x${data.height})`;
    }
    this.tunnelFrameCount += 1;
    const elapsed = Math.max(1, (performance.now() - this.tunnelStartedAt) / 1000);
    document.getElementById('fpsDisplay').textContent = `${Math.round(this.tunnelFrameCount / elapsed)} FPS`;
    this.updateNetworkUI(`隧道中继已连接。当前经 Cloudflare/Socket.IO 转发，延迟约 ${latency || '-'} ms。`, 'warning');
  },
  
  async createOffer() {
    console.log('[OFFER-DBG] createOffer called: networkMode=%s pc=%s offerInProgress=%s',
      this.networkMode, !!this.pc, this.offerInProgress);
    if (this.networkMode === 'tunnel') {
      console.log('[OFFER-DBG] createOffer: tunnel mode, starting relay');
      this.startTunnelRelay();
      return;
    }
    if (this._tunnelLockUntil > Date.now() && (this.networkMode === 'auto' || this.networkMode === 'stun')) {
      console.warn('[NETWORK] Tunnel relay lock active, skipping WebRTC offer');
      this.startTunnelRelay();
      return;
    }
    if (!this.pc || this.offerInProgress) {
      console.warn('[OFFER-DBG] createOffer blocked: pc=%s offerInProgress=%s',
        !!this.pc, this.offerInProgress);
      return;
    }
    this.offerInProgress = true;
    this._offerEpoch += 1;
    const epoch = this._offerEpoch;

    try {
      if (epoch !== this._offerEpoch) return;
      const existingVideoTransceiver = this.pc.getTransceivers().find((transceiver) => {
        return transceiver.receiver?.track?.kind === 'video' || transceiver.mid === '0';
      });
      this.videoTransceiver = existingVideoTransceiver || this.videoTransceiver;
      if (!this.videoTransceiver) {
        this.videoTransceiver = this.pc.addTransceiver('video', { direction: 'recvonly' });
        this.preferH264(this.videoTransceiver);
      }

      const offer = await this.pc.createOffer();
      if (epoch !== this._offerEpoch) return;
      await this.pc.setLocalDescription(offer);
      if (this.networkMode === 'relay' || this.useRelayFallback) {
        await this.waitForIceGatheringComplete(8000);
      }
      if (epoch !== this._offerEpoch) return;

      console.log('[OFFER-DBG] Emitting offer: socketConnected=%s epoch=%d', this.socket.connected, epoch);
      this.socket.emit('offer', { offer: this.pc.localDescription, epoch: epoch });
      console.log('Offer sent (epoch=%d)', epoch);
    } catch (err) {
      console.error('Failed to create offer:', err);
      this.scheduleReconnect('offer-error');
    } finally {
      if (epoch === this._offerEpoch) {
        this.offerInProgress = false;
      }
    }
  },

  waitForIceGatheringComplete(timeoutMs) {
    if (!this.pc || this.pc.iceGatheringState === 'complete') {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pc?.removeEventListener('icegatheringstatechange', onStateChange);
        console.warn(`[NETWORK] ICE gathering wait timed out after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);

      const onStateChange = () => {
        if (!this.pc || this.pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          this.pc?.removeEventListener('icegatheringstatechange', onStateChange);
          resolve();
        }
      };

      this.pc.addEventListener('icegatheringstatechange', onStateChange);
    });
  },

  preferH264(transceiver) {
    if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') {
      return;
    }
    if (!window.RTCRtpReceiver || typeof RTCRtpReceiver.getCapabilities !== 'function') {
      return;
    }

    const capabilities = RTCRtpReceiver.getCapabilities('video');
    if (!capabilities || !Array.isArray(capabilities.codecs)) {
      return;
    }

    const codecs = capabilities.codecs;
    const h264 = codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/h264');
    if (!h264.length) {
      console.warn('[LATENCY] Browser has no H.264 receive capability; keeping default codec order');
      return;
    }

    const rtx = codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/rtx');
    const rest = codecs.filter((codec) => codec.mimeType.toLowerCase() !== 'video/h264' && codec.mimeType.toLowerCase() !== 'video/rtx');
    transceiver.setCodecPreferences([...h264, ...rtx, ...rest]);
    console.log('[LATENCY] Preferred H.264 for video offer:', h264.map((codec) => codec.sdpFmtpLine || codec.mimeType));
  },
  
  async requestResolution(width, height) {
    this.currentResolution = { width, height, label: `${width}x${height}` };
    if (this.socket) {
      this.socket.emit('resolution-change', { width, height });
    }
    if (this.networkMode === 'tunnel' && this.tunnelRelayActive) {
      this.startTunnelRelay();
    }
  },

  configureNetworkControls() {
    const modeBtn = document.getElementById('networkModeBtn');
    const modal = document.getElementById('networkModal');
    const applyBtn = document.getElementById('applyNetworkMode');
    const closeBtn = document.getElementById('closeNetworkMode');
    const turnStatus = document.getElementById('networkTurnStatus');

    if (modeBtn && !modeBtn.dataset.bound) {
      modeBtn.dataset.bound = '1';
      modeBtn.addEventListener('click', () => {
        this.syncNetworkModal();
        modal?.classList.remove('hidden');
      });
    }

    if (closeBtn && !closeBtn.dataset.bound) {
      closeBtn.dataset.bound = '1';
      closeBtn.addEventListener('click', () => modal?.classList.add('hidden'));
    }

    if (modal && !modal.dataset.bound) {
      modal.dataset.bound = '1';
      modal.addEventListener('click', (event) => {
        if (event.target === modal) {
          modal.classList.add('hidden');
        }
      });
    }

    if (applyBtn && !applyBtn.dataset.bound) {
      applyBtn.dataset.bound = '1';
      applyBtn.addEventListener('click', () => {
        const selected = document.querySelector('input[name="networkMode"]:checked');
        if (selected) {
          this.setNetworkMode(selected.value);
          modal?.classList.add('hidden');
        }
      });
    }

    if (turnStatus) {
      turnStatus.textContent = this.serverConfig?.turnConfigured
        ? `TURN 已配置：${(this.serverConfig.turnUrls || []).join(', ')}`
        : 'TURN 未配置：当前只能做 STUN 直连；跨网络失败时会回退隧道中继。若要稳定外网中继，请配置 TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL。';
    }
    this.syncNetworkModal();
  },

  syncNetworkModal() {
    const selected = document.querySelector(`input[name="networkMode"][value="${this.networkMode}"]`);
    if (selected) {
      selected.checked = true;
    }
  },

  setNetworkMode(mode) {
    if (!this.networkModes[mode]) {
      return;
    }
    const modeState = this.enforceSupportedNetworkMode(mode);
    this.useRelayFallback = false;
    this._autoFailCount = 0;
    this.updateNetworkUI(
      modeState.changed ? modeState.reason : '网络模式已切换，正在重连...',
      modeState.changed ? 'warning' : ''
    );
    if (this.socket && this.socket.connected) {
      this.refresh();
    }
  },

  updateNetworkUI(message, severity = '') {
    const mode = this.networkModes[this.networkMode] || this.networkModes.auto;
    const modeBtn = document.getElementById('networkModeBtn');
    const advisor = document.getElementById('networkAdvisor');
    const title = document.getElementById('networkAdvisorTitle');
    const state = document.getElementById('networkAdvisorState');
    const text = document.getElementById('networkAdvisorText');

    if (modeBtn) {
      modeBtn.textContent = `网络：${mode.label}`;
    }
    if (!advisor || !title || !state || !text) {
      return;
    }

    let detail = message || mode.hint;
    if (this.networkMode === 'relay' && !this.hasTurnConfigured()) {
      severity = 'warning';
      detail = this.serverConfig?.turnStatus === 'misconfigured'
        ? 'TURN 配置不完整。当前无法建立真实外网中继，建议补全 TURN_USERNAME / TURN_CREDENTIAL，或先使用隧道中继。'
        : '外网中继需要 TURN。当前未配置 TURN，页面会直接切换到隧道中继。';
    } else if (this.networkMode === 'auto' && !this.hasTurnConfigured()) {
      detail = message || '当前为 STUN-only 自动模式。若外网直连失败，页面会自动切换到隧道中继。';
    }

    title.textContent = `网络模式：${mode.label}`;
    state.textContent = mode.state;
    text.textContent = detail || mode.hint;
    advisor.classList.toggle('warning', severity === 'warning');
    advisor.classList.toggle('danger', severity === 'danger');
    advisor.classList.add('visible');
  },
  
  startStats() {
    console.log('[STATS] Timer started');
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
    }

    this.statsTimer = setInterval(async () => {
      if (!this.pc) {
        console.warn('[STATS] No PC, skipping');
        return;
      }

      let stats;
      try {
        stats = await this.pc.getStats();
      } catch (err) {
        console.warn('[STATS] getStats failed:', err.message || err);
        return;
      }
      if (!stats) {
        console.warn('[STATS] getStats returned null/undefined');
        return;
      }
      let fps = 0;
      let latencyMs = 0;
      let jitterBufferDelay = 0;
      let framesReceived = 0;
      let framesDecoded = 0;
      let packetsLost = 0;
      let bytesReceived = 0;
      let codec = '';
      let selectedCandidateType = '';
      let codecId = '';
      let localCandidateId = '';
      let remoteCandidateId = '';

      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          fps = report.framesPerSecond || 0;
          framesReceived = report.framesReceived || 0;
          framesDecoded = report.framesDecoded || 0;
          packetsLost = report.packetsLost || 0;
          bytesReceived = report.bytesReceived || 0;
          codecId = report.codecId || '';
          if (report.jitterBufferDelay && report.jitterBufferEmittedCount) {
            jitterBufferDelay = (report.jitterBufferDelay / report.jitterBufferEmittedCount * 1000).toFixed(1);
          }
        }
        if (report.type === 'codec' && report.id === codecId) {
          codec = report.mimeType || '';
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const rtt = report.currentRoundTripTime;
          if (typeof rtt === 'number') {
            latencyMs = Math.round(rtt * 1000);
          }
          selectedCandidateType = report.localCandidateType || '';
          localCandidateId = report.localCandidateId || '';
          remoteCandidateId = report.remoteCandidateId || '';
        }
      });

      if (codecId && stats.has(codecId)) {
        const codecReport = stats.get(codecId);
        codec = codecReport.mimeType || codec;
      }
      if (!selectedCandidateType && localCandidateId && stats.has(localCandidateId)) {
        selectedCandidateType = stats.get(localCandidateId).candidateType || '';
      }
      const localCandidate = localCandidateId && stats.has(localCandidateId) ? stats.get(localCandidateId) : null;
      const remoteCandidate = remoteCandidateId && stats.has(remoteCandidateId) ? stats.get(remoteCandidateId) : null;
      this.selectedCandidatePair = {
        localType: localCandidate?.candidateType || selectedCandidateType || '',
        remoteType: remoteCandidate?.candidateType || '',
        protocol: localCandidate?.protocol || remoteCandidate?.protocol || '',
        localAddress: localCandidate?.address && localCandidate?.port ? `${localCandidate.address}:${localCandidate.port}` : '',
        remoteAddress: remoteCandidate?.address && remoteCandidate?.port ? `${remoteCandidate.address}:${remoteCandidate.port}` : '',
        localAddressFamily: this.detectAddressFamily(localCandidate?.address || ''),
        remoteAddressFamily: this.detectAddressFamily(remoteCandidate?.address || ''),
        rttMs: latencyMs || 0,
      };

      document.getElementById('fpsDisplay').textContent = `${Math.round(fps)} FPS`;
      const latencyEl = document.getElementById('latencyDisplay');
      if (latencyEl) {
        latencyEl.textContent = latencyMs > 0 ? `${latencyMs} ms` : '- ms';
      }
      const candidateEl = document.getElementById('candidateDisplay');
      if (candidateEl) {
        const linkLabel = selectedCandidateType === 'relay' ? 'TURN中继' : selectedCandidateType === 'srflx' || selectedCandidateType === 'prflx' ? 'STUN直连' : selectedCandidateType === 'host' ? '本地直连' : selectedCandidateType || '-';
        candidateEl.textContent = `当前链路：${linkLabel}${latencyMs > 0 ? ` · ${latencyMs} ms` : ''}`;
      }
      this.lastCandidateType = selectedCandidateType || '';

      if (framesReceived === 0 && framesDecoded === 0 && !selectedCandidateType) {
        this.noMediaTicks += 1;
      } else {
        this.noMediaTicks = 0;
      }

      if (selectedCandidateType === 'relay') {
        this.updateNetworkUI(`当前通过 TURN 中继传输。RTT ${latencyMs || '-'} ms，适合受限外网但延迟会高于本地直连。`);
      } else if (selectedCandidateType === 'host') {
        this.updateNetworkUI(`当前为本地/直连链路。RTT ${latencyMs || '-'} ms，这是最低延迟路径。`);
      } else if (selectedCandidateType === 'srflx' || selectedCandidateType === 'prflx') {
        this.updateNetworkUI(`当前为外网穿透直连。RTT ${latencyMs || '-'} ms；若画面不稳定可切换外网中继。`);
      } else if (this.noMediaTicks >= 3) {
        const hasTurn = this.hasTurnConfigured();
        this.updateNetworkUI(
          this.networkMode === 'relay'
            ? '外网中继仍未生成媒体链路。建议切换到“隧道中继”，它不依赖 UDP/TURN。'
            : hasTurn
            ? '已连续多次 0 FPS 且未选出媒体链路。可先试“外网中继”，仍失败则切换“隧道中继”。'
            : '已连续多次 0 FPS 且未选出媒体链路。当前没有 TURN，受限外网无法可靠投屏。',
          'danger'
        );
      }

      console.log(`[STATS] FPS=${fps.toFixed(1)}, RTT=${latencyMs}ms, Jitter=${jitterBufferDelay}ms, ` +
                  `Codec=${codec || 'unknown'}, Candidate=${selectedCandidateType || 'unknown'}, ` +
                  `Recv=${framesReceived}, Decoded=${framesDecoded}, Lost=${packetsLost}, ` +
                  `Bytes=${(bytesReceived/1024/1024).toFixed(2)}MB`);
      if (this.selectedCandidatePair.localType || this.selectedCandidatePair.remoteType) {
        console.log('[NETWORK] Selected candidate pair:', this.selectedCandidatePair);
      }

      if (this.socket && this.socket.connected) {
        this.socket.emit('viewer-stats', {
          fps,
          rttMs: latencyMs,
          jitterBufferMs: Number(jitterBufferDelay) || 0,
          framesReceived,
          framesDecoded,
          packetsLost,
          bytesReceived,
          codec,
          selectedCandidateType
        });
      }
    }, 2000);
  },

  async refresh() {
    console.log('Refreshing WebRTC connection...');
    this._refreshing = true;
    this.manualDisconnect = false;
    this.offerInProgress = false;
    this._offerEpoch += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this._dcTimeout) {
      clearTimeout(this._dcTimeout);
      this._dcTimeout = null;
    }
    if (this._disconnectedTimer) {
      clearTimeout(this._disconnectedTimer);
      this._disconnectedTimer = null;
    }
    if (this._iceDisconnectedTimer) {
      clearTimeout(this._iceDisconnectedTimer);
      this._iceDisconnectedTimer = null;
    }
    if (this._dcReconnectTimer) {
      clearTimeout(this._dcReconnectTimer);
      this._dcReconnectTimer = null;
    }
    const videoElement = document.getElementById('remoteVideo');
    videoElement.classList.remove('connected');
    document.body.classList.remove('stream-connected');
    document.getElementById('loading').classList.remove('hidden');
    updateLoadingText('正在重新连接...');
    this.stopTunnelRelay();

    if (this.pc) {
      // Remove event handlers BEFORE closing to prevent spurious reconnect scheduling
      this.pc.oniceconnectionstatechange = null;
      this.pc.onconnectionstatechange = null;
      this.pc.onsignalingstatechange = null;
      this.pc.onicegatheringstatechange = null;
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.close();
      this.pc = null;
    }
    // Explicitly clear DataChannel references
    this.inputChannel = null;
    this.inputMoveChannel = null;
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (typeof Input !== 'undefined') {
      Input.setActive(false);
    }

    this._refreshing = false;

    if (this.networkMode === 'tunnel') {
      this.startTunnelRelay();
    } else {
      this.createPeerConnection();
      this.createOffer();
    }
  },

  scheduleReconnect(reason) {
    if (this.manualDisconnect || this.reconnectTimer || this._refreshing) {
      return;
    }
    console.warn(`[RECOVERY] Scheduling WebRTC reconnect after ${reason}`);
    if (typeof Diagnostic !== 'undefined' && typeof Diagnostic.autoSendFailure === 'function') {
      Diagnostic.autoSendFailure(reason);
    }
    updateConnectionStatus('disconnected');
    this._autoFailCount += 1;

    const hasTurn = this.hasTurnConfigured();
    const canRestartIce = this.pc
      && typeof this.pc.restartIce === 'function'
      && !this.tunnelRelayActive
      && this.networkMode !== 'tunnel'
      && this._iceRestartAttempts < 1
      && ['ice-failed', 'ice-disconnected', 'pc-failed'].includes(reason);

    if (this._tunnelLockUntil > Date.now() && (this.networkMode === 'auto' || this.networkMode === 'stun')) {
      console.warn('[RECOVERY] Tunnel relay lock active, keeping tunnel path');
      updateLoadingText('保持隧道中继，避免重复切回直连...');
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.manualDisconnect || !this.socket || !this.socket.connected) return;
        this.startTunnelRelay();
      }, 500);
      return;
    }

    if (canRestartIce) {
      this._iceRestartAttempts += 1;
      console.warn('[RECOVERY] Trying ICE restart before full refresh');
      updateLoadingText('媒体链路异常，正在尝试 ICE 重启...');
      try {
        this.pc.restartIce();
      } catch (err) {
        console.warn('[RECOVERY] restartIce failed, will fall back to full refresh', err);
      }
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.manualDisconnect || !this.socket || !this.socket.connected) {
          return;
        }
        this.refresh();
      }, 1500);
      return;
    }

    if (this.networkMode === 'auto' && !this.useRelayFallback && hasTurn) {
      this.useRelayFallback = true;
      this.updateNetworkUI('自动穿透失败，下一次重连将强制使用 TURN 中继。', 'warning');
      updateLoadingText('直连失败，正在切换中继...');
    } else if (this.networkMode === 'auto' && (this.useRelayFallback || this._autoFailCount >= 2)) {
      // TURN relay failed or 2+ stun failures without TURN, fall back to tunnel
      console.warn('[RECOVERY] Auto mode exhausted (failCount=%d), falling to tunnel', this._autoFailCount);
      this.useRelayFallback = false;
      this._autoFailCount = 0;
      this.updateNetworkUI('WebRTC 连接失败，正在切换到隧道中继…', 'warning');
      updateLoadingText('切换隧道中继…');
      document.getElementById('loading').classList.remove('hidden');
      document.body.classList.remove('stream-connected');
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.manualDisconnect || !this.socket || !this.socket.connected) return;
        this.startTunnelRelay();
      }, 1000);
      return;
    } else if (this.networkMode === 'stun' && this._autoFailCount >= 2) {
      // STUN exhausted without TURN, fall back to tunnel
      console.warn('[RECOVERY] STUN mode exhausted (failCount=%d), falling to tunnel', this._autoFailCount);
      this._autoFailCount = 0;
      this.updateNetworkUI('外网直连失败，正在切换到隧道中继…', 'warning');
      updateLoadingText('切换隧道中继…');
      document.getElementById('loading').classList.remove('hidden');
      document.body.classList.remove('stream-connected');
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.manualDisconnect || !this.socket || !this.socket.connected) return;
        this.startTunnelRelay();
      }, 1000);
      return;
    } else if (this.networkMode === 'relay' && !this.getTurnServers().length) {
      // relay mode with no TURN configured, suggest tunnel
      this.updateNetworkUI('外网中继无 TURN 配置，建议切换到隧道中继。', 'danger');
      updateLoadingText('TURN 未配置，无法中继…');
    } else {
      updateLoadingText('连接中断，正在自动重连...');
    }
    document.getElementById('loading').classList.remove('hidden');
    document.body.classList.remove('stream-connected');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualDisconnect || !this.socket || !this.socket.connected) {
        return;
      }
      this.refresh();
    }, 1500);
  },

  disconnect() {
    this.manualDisconnect = true;
    this.offerInProgress = false;
    this._offerEpoch += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this._disconnectedTimer) {
      clearTimeout(this._disconnectedTimer);
      this._disconnectedTimer = null;
    }
    if (this._iceDisconnectedTimer) {
      clearTimeout(this._iceDisconnectedTimer);
      this._iceDisconnectedTimer = null;
    }
    if (this._dcReconnectTimer) {
      clearTimeout(this._dcReconnectTimer);
      this._dcReconnectTimer = null;
    }
    if (typeof Input !== 'undefined') {
      Input.setActive(false);
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.stopTunnelRelay();
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    document.getElementById('remoteVideo').classList.remove('connected');
    document.body.classList.remove('stream-connected');
    Auth.logout();
  }
};

function updateConnectionStatus(status) {
  const statusEl = document.getElementById('connectionStatus');
  statusEl.className = 'status ' + status;
  
  const statusText = {
    'connecting': '连接中',
    'connected': '已连接',
    'disconnected': '已断开'
  };
  statusEl.textContent = statusText[status] || status;
}

function updateLoadingText(text) {
  const loadingText = document.getElementById('loadingText');
  if (loadingText) {
    loadingText.textContent = text;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  WebRTC.loadServerConfig().then(() => {
    WebRTC.configureNetworkControls();
    WebRTC.updateNetworkUI('请根据访问环境选择网络模式。');
  });

  const startBtn = document.getElementById('startBtn');
  if (startBtn) {
    startBtn.addEventListener('click', () => {
      if (Auth.isLoggedIn()) {
        WebRTC.init();
        startBtn.style.display = 'none';
        document.getElementById('loadingText').textContent = '正在连接...';
      }
    });
  }

  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    let lastRefreshTime = 0;
    refreshBtn.addEventListener('click', () => {
      const now = Date.now();
      if (now - lastRefreshTime < 5000) {
        console.log('[REFRESH] Debounced: too soon since last refresh');
        return;
      }
      lastRefreshTime = now;
      WebRTC.refresh();
    });
  }

  // Resolution modal
  const resolutionBtn = document.getElementById('resolutionBtn');
  const resolutionModal = document.getElementById('resolutionModal');
  const applyResolution = document.getElementById('applyResolution');
  const closeResolution = document.getElementById('closeResolution');

  if (resolutionBtn && resolutionModal) {
    resolutionBtn.addEventListener('click', () => {
      resolutionModal.classList.remove('hidden');
    });
  }
  if (closeResolution && resolutionModal) {
    closeResolution.addEventListener('click', () => {
      resolutionModal.classList.add('hidden');
    });
  }
  if (applyResolution && resolutionModal) {
    applyResolution.addEventListener('click', () => {
      const selected = document.querySelector('input[name="resolution"]:checked');
      if (selected) {
        const width = parseInt(selected.dataset.width, 10);
        const height = parseInt(selected.dataset.height, 10);
        WebRTC.requestResolution(width, height);
        document.getElementById('resolutionDisplay').textContent = `${width}x${height}`;
      }
      resolutionModal.classList.add('hidden');
    });
  }
  if (resolutionModal) {
    resolutionModal.addEventListener('click', (event) => {
      if (event.target === resolutionModal) {
        resolutionModal.classList.add('hidden');
      }
    });
  }
});
