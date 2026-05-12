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
      hint: '默认模式。先走低延迟直连，网络穿透失败时使用已配置的 TURN 中继。'
    },
    stun: {
      label: '外网直连',
      state: '看网络',
      hint: '适合外网但 UDP 未被限制的环境。若一直 0 FPS 或链路未知，请切换外网中继。'
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
  
  async init() {
    const token = Auth.getToken();
    if (!token) {
      console.error('No token available');
      return;
    }
    this.manualDisconnect = false;
    await this.loadServerConfig();
    this.configureNetworkControls();
    this.updateNetworkUI('网络模式已就绪');

    this.socket = io(window.location.origin, {
      auth: { token, role: 'viewer' }
    });

    this.setupSocketListeners();
    this.createPeerConnection();
  },

  async loadServerConfig() {
    try {
      const response = await fetch('/api/webrtc-config', { cache: 'no-store' });
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
    const stunUrls = this.serverConfig?.stunUrls?.length
      ? this.serverConfig.stunUrls
      : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
    return stunUrls.length ? [{ urls: stunUrls }] : [];
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
      if (!turnServers.length) {
        console.warn('[NETWORK] Relay mode selected but TURN is not configured; falling back to STUN');
        iceServers = this.getStunServers();
        iceTransportPolicy = 'all';
      }
    } else if (this.useRelayFallback && turnServers.length) {
      iceServers = turnServers;
      iceTransportPolicy = 'relay';
    } else {
      iceServers = [...this.getStunServers(), ...turnServers];
    }

    return { iceServers, iceTransportPolicy };
  },
  
  setupSocketListeners() {
    this.socket.on('connect', () => {
      console.log('Signaling connected');
      updateConnectionStatus('connecting');
      if (!this.pc || ['failed', 'closed'].includes(this.pc.connectionState)) {
        this.createPeerConnection();
      }
    });

    this.socket.on('connected', (data) => {
      console.log('Server acknowledged:', data);

      if (data.hostOnline) {
        this.createOffer();
      } else {
        updateLoadingText('等待Host上线...');
      }
    });

    this.socket.on('host-status', (data) => {
      console.log('Host status:', data);
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
    this.noMediaTicks = 0;
    this.lastCandidateType = '';
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
      if (['failed', 'disconnected', 'closed'].includes(this.pc.iceConnectionState)) {
        this.scheduleReconnect(`ice-${this.pc.iceConnectionState}`);
      }
    };

    this.pc.onconnectionstatechange = () => {
      console.log('Viewer Connection state:', this.pc.connectionState);
      if (this.pc.connectionState === 'connected') {
        console.log('WebRTC connected, initializing input...');
        this.updateNetworkUI('媒体链路已连接');
        this._autoFailCount = 0;

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
        // Estimate playout buffer periodically
        if (!this._playoutEstimateInterval) {
          this._playoutEstimateInterval = setInterval(() => {
            if (typeof LatencyMonitor !== 'undefined') {
              LatencyMonitor._estimatePlayoutBuffer();
            }
          }, 2000);
        }
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
        if (this._playoutEstimateInterval) {
          clearInterval(this._playoutEstimateInterval);
          this._playoutEstimateInterval = null;
        }
        this.updateNetworkUI('媒体链路失败，请按浮窗建议切换网络模式', 'danger');
        this.scheduleReconnect(`pc-${this.pc.connectionState}`);
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

      this.startStats();
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

    // Timeout detection: if DataChannel doesn't open within 8s, trigger reconnect
    this._dcTimeout = setTimeout(() => {
      if (this.inputChannel && this.inputChannel.readyState !== 'open') {
        console.warn('[INPUT-DC] DataChannel stuck in state:', this.inputChannel.readyState, '- forcing reconnect');
        this.scheduleReconnect('dc-stuck');
      }
    }, 8000);

    this.inputChannel.onopen = () => {
      console.log('[INPUT-DC] DataChannel open');
      if (this._dcTimeout) { clearTimeout(this._dcTimeout); this._dcTimeout = null; }
      if (typeof Input !== 'undefined') {
        Input.updateKeyDisplayRaw('输入直连已就绪');
      }
    };
    this.inputChannel.onclose = () => {
      console.log('[INPUT-DC] DataChannel closed');
      if (this._dcTimeout) { clearTimeout(this._dcTimeout); this._dcTimeout = null; }
    };
    this.inputChannel.onerror = (event) => {
      console.warn('[INPUT-DC] DataChannel error:', event);
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
    this.relaySocket = io(window.location.origin, {
      auth: { token, role: 'relay-viewer' },
      transports: ['websocket', 'polling']
    });
    this.relaySocket.on('connect', () => {
      console.log('[TUNNEL] Relay socket connected');
      if (this.networkMode === 'tunnel' && this.tunnelRelayActive) {
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
    if (this.networkMode !== 'tunnel') {
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
    if (this.networkMode === 'tunnel') {
      this.startTunnelRelay();
      return;
    }
    if (!this.pc || this.offerInProgress) return;
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

      this.socket.emit('offer', { offer: this.pc.localDescription });
      console.log('Offer sent (epoch=%d)', epoch);
    } catch (err) {
      console.error('Failed to create offer:', err);
      this.scheduleReconnect('offer-error');
    } finally {
      this.offerInProgress = false;
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
        : 'TURN 未配置：外网中继模式会退回 STUN，跨网络失败时需要配置 TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL。';
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
    this.networkMode = mode;
    this.useRelayFallback = false;
    this._autoFailCount = 0;
    localStorage.setItem('wrdNetworkMode', mode);
    this.updateNetworkUI('网络模式已切换，正在重连...');
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
    if (this.networkMode === 'relay' && !this.getTurnServers().length) {
      severity = 'warning';
      detail = '外网中继需要 TURN。当前未配置 TURN，页面会退回 STUN，受限网络仍可能 0 FPS。';
    }

    title.textContent = `网络模式：${mode.label}`;
    state.textContent = mode.state;
    text.textContent = detail || mode.hint;
    advisor.classList.toggle('warning', severity === 'warning');
    advisor.classList.toggle('danger', severity === 'danger');
    advisor.classList.add('visible');
  },
  
  startStats() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
    }

    this.statsTimer = setInterval(async () => {
      if (!this.pc) return;

      let stats;
      try {
        stats = await this.pc.getStats();
      } catch (err) {
        console.warn('Failed to get WebRTC stats:', err);
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
        }
      });

      if (codecId && stats.has(codecId)) {
        const codecReport = stats.get(codecId);
        codec = codecReport.mimeType || codec;
      }
      if (!selectedCandidateType && localCandidateId && stats.has(localCandidateId)) {
        selectedCandidateType = stats.get(localCandidateId).candidateType || '';
      }

      document.getElementById('fpsDisplay').textContent = `${Math.round(fps)} FPS`;
      const latencyEl = document.getElementById('latencyDisplay');
      if (latencyEl) {
        latencyEl.textContent = latencyMs > 0 ? `${latencyMs} ms` : '- ms';
      }
      const candidateEl = document.getElementById('candidateDisplay');
      if (candidateEl) {
        candidateEl.textContent = `链路 ${selectedCandidateType || '-'}`;
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
        const hasTurn = this.getTurnServers().length > 0;
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
    this._offerEpoch += 1;
    this.manualDisconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const videoElement = document.getElementById('remoteVideo');
    videoElement.classList.remove('connected');
    document.body.classList.remove('stream-connected');
    document.getElementById('loading').classList.remove('hidden');
    updateLoadingText('正在重新连接...');
    this.stopTunnelRelay();

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (typeof Input !== 'undefined') {
      Input.setActive(false);
    }

    if (this.networkMode === 'tunnel') {
      this.startTunnelRelay();
    } else {
      this.createPeerConnection();
      this.createOffer();
    }
  },

  scheduleReconnect(reason) {
    if (this.manualDisconnect || this.reconnectTimer) {
      return;
    }
    console.warn(`[RECOVERY] Scheduling WebRTC reconnect after ${reason}`);
    updateConnectionStatus('disconnected');
    this._autoFailCount += 1;

    if (this.networkMode === 'auto' && !this.useRelayFallback && this.getTurnServers().length) {
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
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
    refreshBtn.addEventListener('click', () => {
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
