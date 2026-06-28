const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeElement() {
  const classes = new Set();
  return {
    textContent: '',
    style: {},
    src: '',
    classList: {
      add(...tokens) { tokens.forEach((token) => classes.add(token)); },
      remove(...tokens) { tokens.forEach((token) => classes.delete(token)); },
      contains(token) { return classes.has(token); },
      toggle(token, force) {
        if (force === true) {
          classes.add(token);
          return true;
        }
        if (force === false) {
          classes.delete(token);
          return false;
        }
        if (classes.has(token)) {
          classes.delete(token);
          return false;
        }
        classes.add(token);
        return true;
      },
    },
    addEventListener() {},
    removeAttribute() {},
    setAttribute() {},
  };
}

function loadWebRTC(overrides = {}) {
  const elements = new Map();
  const context = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance: { now: () => 0 },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    document: {
      body: makeElement(),
      addEventListener() {},
      querySelector: () => null,
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, makeElement());
        }
        return elements.get(id);
      },
    },
    Auth: {
      getToken: () => 'token',
      isLoggedIn: () => true,
      logout: () => {},
    },
    RTCSessionDescription: function RTCSessionDescription(value) { return value; },
    RTCIceCandidate: function RTCIceCandidate(value) { return value; },
    RTCRtpReceiver: null,
    window: {
      location: { origin: 'http://127.0.0.1:8080' },
      RTCRtpReceiver: null,
    },
    io: () => ({ on() {}, emit() {}, disconnect() {}, connected: true }),
  };
  Object.assign(context, overrides);
  if (overrides.document) {
    context.document = overrides.document;
  }
  if (overrides.window) {
    context.window = overrides.window;
  }
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'webrtc.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__WebRTC = WebRTC;`, context);
  return { WebRTC: context.__WebRTC, context, elements };
}

test('refresh clears stuck offer state before creating a new offer', async () => {
  const { WebRTC } = loadWebRTC();
  const observed = [];
  let closed = false;

  WebRTC.socket = { connected: true };
  WebRTC.offerInProgress = true;
  WebRTC.pc = {
    close() { closed = true; },
  };
  WebRTC.stopTunnelRelay = () => {};
  WebRTC.createPeerConnection = () => {
    WebRTC.pc = { close() {} };
  };
  WebRTC.createOffer = () => {
    observed.push(WebRTC.offerInProgress);
  };

  await WebRTC.refresh();

  assert.equal(closed, true);
  assert.deepEqual(observed, [false]);
});

test('stale createOffer completion does not clear newer offer progress', async () => {
  const { WebRTC } = loadWebRTC();
  let resolveOffer;

  WebRTC.socket = {
    connected: true,
    emit() {},
  };
  WebRTC.pc = {
    getTransceivers: () => [],
    addTransceiver: () => ({}),
    createOffer: () => new Promise((resolve) => {
      resolveOffer = () => resolve({ type: 'offer', sdp: 'old' });
    }),
    setLocalDescription: async () => {},
    localDescription: { type: 'offer', sdp: 'old' },
  };
  WebRTC.preferH264 = () => {};

  const staleOffer = WebRTC.createOffer();
  assert.equal(WebRTC.offerInProgress, true);

  WebRTC._offerEpoch += 1;
  WebRTC.offerInProgress = true;
  resolveOffer();
  await staleOffer;

  assert.equal(WebRTC.offerInProgress, true);
});

test('auto fallback handles relay frames while tunnel relay is active', () => {
  const { WebRTC, elements } = loadWebRTC();
  const relayImage = elements.get('relayImage') || makeElement();
  relayImage.classList.add('hidden');
  elements.set('relayImage', relayImage);

  WebRTC.networkMode = 'auto';
  WebRTC.tunnelRelayActive = true;

  WebRTC.handleRelayFrame({
    data: 'ZmFrZS1mcmFtZQ==',
    mime: 'image/jpeg',
    frameId: 1,
    width: 960,
    height: 540,
    timestamp: Date.now(),
  });

  assert.equal(relayImage.classList.contains('hidden'), false);
  assert.equal(elements.get('connectionStatus').textContent, '已连接');
});

test('relay socket connect emits start control during auto tunnel fallback', () => {
  const handlers = new Map();
  const emitted = [];
  const relaySocket = {
    connected: false,
    on(event, callback) {
      handlers.set(event, callback);
    },
    emit(...args) {
      emitted.push(args);
    },
    disconnect() {},
  };
  const { WebRTC } = loadWebRTC({
    io: () => relaySocket,
  });

  WebRTC.networkMode = 'auto';
  WebRTC.tunnelRelayActive = true;

  WebRTC.ensureRelaySocket();
  handlers.get('connect')();

  assert.equal(
    emitted.some(([event]) => event === 'relay-stream-control'),
    true
  );
});

test('relay mode without TURN does not fall back to STUN candidates', () => {
  const { WebRTC } = loadWebRTC();

  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: false,
    turnUrls: [],
    iceServers: [{ urls: ['stun:stun.example.com:3478'] }],
  };
  WebRTC.networkMode = 'relay';

  const config = WebRTC.buildPeerConfig();

  assert.equal(config.iceTransportPolicy, 'relay');
  assert.equal(Array.isArray(config.iceServers), true);
  assert.equal(config.iceServers.length, 0);
});

test('stun mode builds deduplicated STUN config with candidate pool', () => {
  const { WebRTC } = loadWebRTC();

  WebRTC.serverConfig = {
    stunUrls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun.l.google.com:19302',
    ],
    turnConfigured: false,
    turnUrls: [],
    iceServers: [],
  };
  WebRTC.networkMode = 'stun';

  const config = WebRTC.buildPeerConfig();

  assert.equal(config.iceTransportPolicy, 'all');
  assert.equal(config.iceCandidatePoolSize, 4);
  assert.equal(config.bundlePolicy, 'max-bundle');
  assert.equal(config.iceServers.length, 1);
  assert.deepEqual(Array.from(config.iceServers[0].urls), [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302',
  ]);
});

test('selecting relay without TURN switches to tunnel mode explicitly', () => {
  let savedMode = null;
  const { WebRTC } = loadWebRTC({
    localStorage: {
      getItem: () => null,
      setItem: (_key, value) => {
        savedMode = value;
      },
    },
  });

  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: false,
    turnUrls: [],
    iceServers: [{ urls: ['stun:stun.example.com:3478'] }],
  };
  WebRTC.socket = { connected: false };

  WebRTC.setNetworkMode('relay');

  assert.equal(WebRTC.networkMode, 'tunnel');
  assert.equal(savedMode, 'tunnel');
});

test('collectNetworkSnapshot summarizes candidate and state context', () => {
  const { WebRTC } = loadWebRTC();

  WebRTC.networkMode = 'stun';
  WebRTC.useRelayFallback = false;
  WebRTC.tunnelRelayActive = false;
  WebRTC._autoFailCount = 2;
  WebRTC.noMediaTicks = 3;
  WebRTC.lastCandidateType = 'srflx';
  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: false,
    turnStatus: 'missing',
    turnUrls: [],
  };
  WebRTC.pc = {
    connectionState: 'failed',
    iceConnectionState: 'failed',
    iceGatheringState: 'complete',
    signalingState: 'stable',
  };
  WebRTC.candidateSummary = {
    local: { host: 2, srflx: 1, relay: 0, prflx: 0, other: 0 },
    remote: { host: 1, srflx: 1, relay: 0, prflx: 0, other: 0 },
    samples: {
      local: [{ type: 'srflx', protocol: 'udp', address: '203.0.113.1:5000' }],
      remote: [{ type: 'host', protocol: 'udp', address: '192.168.0.2:6000' }],
    },
  };
  WebRTC.selectedCandidatePair = {
    localType: 'srflx',
    remoteType: 'host',
    protocol: 'udp',
    localAddress: '203.0.113.1:5000',
    remoteAddress: '192.168.0.2:6000',
    rttMs: 42,
  };

  const snapshot = JSON.parse(JSON.stringify(WebRTC.collectNetworkSnapshot()));

  assert.equal(snapshot.networkMode, 'stun');
  assert.equal(snapshot.turnConfigured, false);
  assert.equal(snapshot.turnStatus, 'missing');
  assert.equal(snapshot.pc.connectionState, 'failed');
  assert.equal(snapshot.candidateSummary.local.srflx, 1);
  assert.equal(snapshot.candidateSummary.remote.host, 1);
  assert.equal(snapshot.candidateSummary.samples.local[0].type, 'srflx');
  assert.equal(snapshot.selectedCandidatePair.localType, 'srflx');
  assert.equal(snapshot.selectedCandidatePair.rttMs, 42);
});

test('scheduleReconnect prefers ICE restart before full refresh in stun mode', () => {
  const { WebRTC } = loadWebRTC();
  const actions = [];

  WebRTC.networkMode = 'stun';
  WebRTC.manualDisconnect = false;
  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: false,
    turnStatus: 'missing',
    turnUrls: [],
  };
  WebRTC.socket = { connected: true };
  WebRTC.pc = {
    restartIce() {
      actions.push('restartIce');
    },
    close() {},
  };
  WebRTC.refresh = () => {
    actions.push('refresh');
  };

  WebRTC.scheduleReconnect('ice-failed');

  assert.equal(actions.includes('restartIce'), true);
  assert.equal(actions.includes('refresh'), false);
});

test('auto without TURN keeps STUN recovery path active after first pc-failed', () => {
  const { WebRTC } = loadWebRTC();
  const actions = [];

  WebRTC.networkMode = 'auto';
  WebRTC.manualDisconnect = false;
  WebRTC.serverConfig = {
    stunUrls: ['stun:stun.example.com:3478'],
    turnConfigured: false,
    turnStatus: 'missing',
    turnUrls: [],
  };
  WebRTC.socket = { connected: true };
  WebRTC.startTunnelRelay = () => {
    actions.push('tunnel');
  };
  WebRTC.refresh = () => {
    actions.push('refresh');
  };
  WebRTC.pc = {
    restartIce() {
      actions.push('restartIce');
    },
    close() {},
  };

  WebRTC.scheduleReconnect('pc-failed');

  assert.equal(WebRTC._tunnelLockUntil, 0);
  assert.equal(WebRTC._autoFailCount, 1);
  assert.equal(actions.includes('restartIce'), true);
  assert.equal(actions.includes('tunnel'), false);
});

test('auto on public origin without TURN keeps auto mode and still starts WebRTC setup', async () => {
  let savedMode = null;
  let createPeerConnectionCalled = false;
  const { WebRTC } = loadWebRTC({
    window: {
      location: { origin: 'https://billing-lanes-metro-admissions.trycloudflare.com' },
      RTCRtpReceiver: null,
    },
    localStorage: {
      getItem: () => 'auto',
      setItem: (_key, value) => {
        savedMode = value;
      },
    },
  });

  WebRTC.loadServerConfig = async () => {
    WebRTC.serverConfig = {
      stunUrls: ['stun:stun.example.com:3478'],
      turnConfigured: false,
      turnStatus: 'missing',
      turnUrls: [],
      iceServers: [{ urls: ['stun:stun.example.com:3478'] }],
    };
  };
  WebRTC.configureNetworkControls = () => {};
  WebRTC.updateNetworkUI = () => {};
  WebRTC.setupSocketListeners = () => {};
  WebRTC.startTunnelRelay = () => {};
  WebRTC.createPeerConnection = () => {
    createPeerConnectionCalled = true;
  };

  await WebRTC.init();

  assert.equal(WebRTC.networkMode, 'auto');
  assert.equal(savedMode, 'auto');
  assert.equal(createPeerConnectionCalled, true);
});

test('public origin without TURN no longer forces tunnel mode during init', async () => {
  const uiMessages = [];
  const { WebRTC } = loadWebRTC({
    window: {
      location: { origin: 'https://billing-lanes-metro-admissions.trycloudflare.com' },
      RTCRtpReceiver: null,
    },
    localStorage: {
      getItem: () => 'auto',
      setItem: () => {},
    },
  });

  WebRTC.loadServerConfig = async () => {
    WebRTC.serverConfig = {
      stunUrls: ['stun:stun.example.com:3478'],
      turnConfigured: false,
      turnStatus: 'missing',
      turnUrls: [],
      iceServers: [{ urls: ['stun:stun.example.com:3478'] }],
    };
  };
  WebRTC.configureNetworkControls = () => {};
  WebRTC.updateNetworkUI = (message) => {
    uiMessages.push(message);
  };
  WebRTC.setupSocketListeners = () => {};
  WebRTC.startTunnelRelay = () => {};
  WebRTC.createPeerConnection = () => {};

  await WebRTC.init();

  assert.equal(WebRTC.networkMode, 'auto');
  assert.ok(uiMessages.every((message) => !String(message).includes('当前是公网入口且未配置 TURN')));
});


test('UI init tolerates missing optional elements', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const elements = new Map();
  function el() {
    return {
      textContent: '',
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener() {},
      focus() {},
      play() {},
      pause() {},
    };
  }
  const context = {
    console,
    document: {
      body: el(),
      fullscreenElement: null,
      addEventListener() {},
      querySelector(sel) {
        if (sel === '.viewer-container') return el();
        return null;
      },
      getElementById(id) {
        if (id === 'pauseBtn' || id === 'disconnectBtn' || id === 'remoteVideo') return el();
        return null;
      },
    },
    Input: { setActive() {} },
    WebRTC: { disconnect() {}, requestResolution() {} },
    confirm: () => true,
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');
  assert.doesNotThrow(() => vm.runInContext(source, context));
});
