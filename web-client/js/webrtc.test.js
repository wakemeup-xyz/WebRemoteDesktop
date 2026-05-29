const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function makeElement() {
  return {
    textContent: '',
    style: {},
    classList: {
      add() {},
      remove() {},
      contains() { return false; },
      toggle() {},
    },
    addEventListener() {},
    removeAttribute() {},
    setAttribute() {},
  };
}

function loadWebRTC() {
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
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'webrtc.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__WebRTC = WebRTC;`, context);
  return context.__WebRTC;
}

test('refresh clears stuck offer state before creating a new offer', async () => {
  const WebRTC = loadWebRTC();
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
  const WebRTC = loadWebRTC();
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
