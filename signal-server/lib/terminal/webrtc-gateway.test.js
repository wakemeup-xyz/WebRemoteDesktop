const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createTerminalWebRtcGateway,
  toNodeIceServers,
} = require('./webrtc-gateway');

test('toNodeIceServers embeds credentials into turn urls', () => {
  const urls = toNodeIceServers(
    ['turn:relay.example.com:3478?transport=udp'],
    'user',
    'pass',
  );
  assert.deepEqual(urls, [
    'turn:user:pass@relay.example.com:3478?transport=udp',
  ]);
});

test('capability reports missing runtime when PeerConnection absent', () => {
  const gateway = createTerminalWebRtcGateway({
    config: {
      turnUrls: ['turn:relay.example.com:3478?transport=udp'],
      turnUsername: 'u',
      turnCredential: 'p',
    },
    PeerConnection: null,
  });
  assert.equal(gateway.available(), false);
  assert.equal(gateway.capability().reason, 'node-datachannel-missing');
});

test('acceptOffer answers, bridges output, and handles ping/input', () => {
  const writes = [];
  const attaches = [];
  class FakePC {
    constructor() {
      this.handlers = {};
      this.remote = null;
    }
    onLocalDescription(fn) { this.handlers.localDescription = fn; }
    onLocalCandidate(fn) { this.handlers.localCandidate = fn; }
    onDataChannel(fn) { this.handlers.dataChannel = fn; }
    setRemoteDescription(sdp, type) {
      this.remote = { sdp, type };
      queueMicrotask(() => {
        this.handlers.localDescription?.('v=0 answer', 'answer');
        this.handlers.localCandidate?.('candidate:1 1 UDP 1 1.1.1.1 9 typ relay', '0');
        const messages = [];
        const dc = {
          sendMessage(text) { messages.push(text); },
          onOpen(fn) { this._open = fn; },
          onClosed() {},
          onMessage(fn) { this._message = fn; },
          close() {},
          _messages: messages,
        };
        this.handlers.dataChannel?.(dc);
        dc._open?.();
        this._dc = dc;
      });
    }
    addRemoteCandidate() {}
    close() {}
  }

  const gateway = createTerminalWebRtcGateway({
    config: {
      turnUrls: ['turn:relay.example.com:3478?transport=udp'],
      turnUsername: 'u',
      turnCredential: 'p',
    },
    PeerConnection: FakePC,
    sessionManager: {
      writeInput(sid, input) {
        writes.push({ sid, data: input.data });
      },
      resizeSession() {},
      attachSession(sid, input) {
        attaches.push({ sid, observerId: input.observerId });
        // Simulate one output chunk immediately.
        queueMicrotask(() => {
          input.onData?.('hello-from-pty\n', { replaySeq: 1 }, () => {});
        });
        return { sessionId: sid, replay: [] };
      },
      detachObserver() {},
    },
  });

  assert.equal(gateway.available(), true);
  const answers = [];
  const candidates = [];
  const entry = gateway.acceptOffer({
    socketId: 'sock-1',
    clientId: 'client-1',
    offer: { type: 'offer', sdp: 'v=0 offer' },
    onLocalDescription: (desc) => answers.push(desc),
    onLocalCandidate: (cand) => candidates.push(cand),
  });

  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        assert.equal(answers.length, 1);
        assert.equal(answers[0].type, 'answer');
        assert.ok(candidates.length >= 1);
        assert.ok(entry.dc);
        entry.dc._message?.(JSON.stringify({ t: 'ping', ts: 123 }));
        const pong = JSON.parse(entry.dc._messages.find((line) => line.includes('"pong"')) || '{}');
        assert.equal(pong.t, 'pong');
        entry.dc._message?.(JSON.stringify({
          t: 'bind',
          sid: 'term_1',
          clientId: 'client-1',
          preferDcOutput: true,
        }));
        entry.dc._message?.(JSON.stringify({ t: 'in', sid: 'term_1', data: 'echo hi\n', inputId: 'i1' }));
      } catch (error) {
        reject(error);
        return;
      }
      setTimeout(() => {
        try {
          assert.equal(writes.length, 1);
          assert.equal(writes[0].sid, 'term_1');
          assert.equal(attaches.length, 1);
          assert.match(attaches[0].observerId, /^webrtc:/);
          const out = entry.dc._messages
            .map((line) => {
              try { return JSON.parse(line); } catch (_err) { return null; }
            })
            .find((item) => item && item.t === 'out');
          assert.ok(out);
          assert.equal(out.data, 'hello-from-pty\n');
          gateway.closeAll();
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 20);
    }, 20);
  });
});
