const WebRTC = {
  pc: null,
  socket: null,
  remoteStream: null,
  
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  },
  
  async init() {
    const token = Auth.getToken();
    if (!token) {
      console.error('No token available');
      return;
    }

    // Connect to production domain
    this.socket = io('https://involves-oklahoma-monitored-admission.trycloudflare.com', {
      auth: { token, role: 'viewer' }
    });

    this.setupSocketListeners();
    this.createPeerConnection();
  },
  
  setupSocketListeners() {
    this.socket.on('connect', () => {
      console.log('Signaling connected');
      updateConnectionStatus('connecting');
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
        this.createOffer();
      } else {
        updateConnectionStatus('disconnected');
        updateLoadingText('Host已离线');
      }
    });

    this.socket.on('answer', async (data) => {
      console.log('Received answer');
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      } catch (err) {
        console.error('Failed to set remote description:', err);
      }
    });

    this.socket.on('ice-candidate', async (data) => {
      console.log('Received ICE candidate');
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('Failed to add ICE candidate:', err);
      }
    });

    this.socket.on('disconnect', () => {
      console.log('Signaling disconnected');
      updateConnectionStatus('disconnected');
    });
  },
  
  createPeerConnection() {
    this.pc = new RTCPeerConnection(this.config);

    // Debug logging
    console.log('Creating RTCPeerConnection with config:', this.config);

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
    };

    this.pc.onconnectionstatechange = () => {
      console.log('Viewer Connection state:', this.pc.connectionState);
    };

    this.pc.onsignalingstatechange = () => {
      console.log('Viewer Signaling state:', this.pc.signalingState);
    };

    this.pc.ontrack = (event) => {
      console.log('Received remote track:', event.track.kind, 'streams:', event.streams.length);
      this.remoteStream = event.streams[0];

      const videoElement = document.getElementById('remoteVideo');
      videoElement.srcObject = this.remoteStream;

      // 确保视频自动播放
      videoElement.muted = true; // 静音才能自动播放
      videoElement.play().then(() => {
        console.log('Video playback started');
      }).catch(err => {
        console.error('Video play failed:', err);
      });

      // 监听视频元数据加载
      videoElement.onloadedmetadata = () => {
        console.log('Video metadata loaded:', videoElement.videoWidth, 'x', videoElement.videoHeight);
        document.getElementById('loading').classList.add('hidden');
        updateConnectionStatus('connected');
      };

      // 监听视频开始播放
      videoElement.onplaying = () => {
        console.log('Video is now playing');
        document.getElementById('loading').classList.add('hidden');
        updateConnectionStatus('connected');
      };

      // Log video stats
      this.remoteStream.getTracks().forEach(track => {
        console.log('Track:', track.kind, 'enabled:', track.enabled, 'state:', track.readyState);
      });

      this.startStats();
    };
  },
  
  async createOffer() {
    try {
      this.pc.addTransceiver('video', { direction: 'recvonly' });
      
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      
      this.socket.emit('offer', { offer });
      console.log('Offer sent');
    } catch (err) {
      console.error('Failed to create offer:', err);
    }
  },
  
  async requestResolution(width, height) {
    if (this.socket) {
      this.socket.emit('resolution-change', { width, height });
    }
  },
  
  startStats() {
    setInterval(async () => {
      if (!this.pc) return;
      
      const stats = await this.pc.getStats();
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          const fps = report.framesPerSecond || 0;
          document.getElementById('fpsDisplay').textContent = `${Math.round(fps)} FPS`;
        }
      });
    }, 1000);
  },
  
  disconnect() {
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
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
  document.getElementById('loadingText').textContent = text;
}

document.addEventListener('DOMContentLoaded', () => {
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
});
