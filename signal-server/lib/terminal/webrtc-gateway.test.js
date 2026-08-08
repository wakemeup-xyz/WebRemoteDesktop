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
  const resizes = [];
  let rejectNextInput = false;
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
        if (rejectNextInput) {
          rejectNextInput = false;
          throw Object.assign(new Error('input rejected'), { code: 'terminal_input_rejected' });
        }
        writes.push({ sid, data: input.data, clientId: input.clientId });
      },
      resizeSession(sid, input) {
        resizes.push({ sid, cols: input.cols, rows: input.rows, clientId: input.clientId });
      },
      attachSession(sid, input) {
        attaches.push({ sid, observerId: input.observerId, clientId: input.clientId });
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
          // Spoofed identity must not override socket-authenticated clientId.
          clientId: 'attacker-spoofed-id',
          preferDcOutput: true,
        }));
        assert.equal(entry.clientId, 'client-1');
        assert.equal(entry.browserLabel, 'attacker-spoofed-id');
        entry.dc._message?.(JSON.stringify({ t: 'in', sid: 'term_1', data: 'echo hi\n', inputId: 'i1' }));
        entry.dc._message?.(JSON.stringify({
          t: 'in', sid: 'term_1', data: 'x'.repeat(64 * 1024 + 1), inputId: 'input-too-large',
        }));
        rejectNextInput = true;
        entry.dc._message?.(JSON.stringify({ t: 'in', sid: 'term_1', data: 'reject', inputId: 'input-rejected' }));
        entry.dc._message?.(JSON.stringify({ t: 'resize', sid: 'term_1', cols: 9999, rows: 9999 }));
        entry.dc._message?.(JSON.stringify({ t: 'resize', sid: 'term_1', cols: 120, rows: 40 }));
      } catch (error) {
        reject(error);
        return;
      }
      setTimeout(() => {
        try {
          assert.equal(writes.length, 1);
          assert.equal(writes[0].sid, 'term_1');
          assert.equal(writes[0].clientId, 'client-1');
          assert.equal(attaches.length, 1);
          assert.equal(attaches[0].clientId, 'client-1');
          assert.match(attaches[0].observerId, /^webrtc:/);
          assert.equal(resizes.length, 1);
          assert.deepEqual(
            { cols: resizes[0].cols, rows: resizes[0].rows, clientId: resizes[0].clientId },
            { cols: 120, rows: 40, clientId: 'client-1' },
          );
          const parsed = entry.dc._messages.map((line) => {
            try { return JSON.parse(line); } catch (_err) { return null; }
          }).filter(Boolean);
          assert.ok(parsed.some((item) => item.t === 'out' && item.data === 'hello-from-pty\n'));
          assert.deepEqual(
            parsed.find((item) => item.code === 'terminal_input_too_large'),
            {
              t: 'error',
              sid: 'term_1',
              inputId: 'input-too-large',
              code: 'terminal_input_too_large',
              message: 'Terminal input exceeds 64KB',
              bytes: 64 * 1024 + 1,
              maxBytes: 64 * 1024,
            },
          );
          assert.deepEqual(
            parsed.find((item) => item.code === 'terminal_input_rejected'),
            {
              t: 'error',
              sid: 'term_1',
              inputId: 'input-rejected',
              code: 'terminal_input_rejected',
              message: 'input rejected',
            },
          );
          assert.ok(parsed.some((item) => item.code === 'terminal_resize_out_of_range'));
          gateway.closeAll();
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 20);
    }, 20);
  });
});

test('closePeer detaches only the webrtc observerId and leaves Socket.IO observer', () => {
  const detaches = [];
  class FakePC {
    constructor() {
      this.handlers = {};
    }
    onLocalDescription(fn) { this.handlers.localDescription = fn; }
    onLocalCandidate() {}
    onDataChannel(fn) { this.handlers.dataChannel = fn; }
    setRemoteDescription() {
      queueMicrotask(() => {
        this.handlers.localDescription?.('v=0 answer', 'answer');
        const dc = {
          sendMessage() {},
          onOpen(fn) { this._open = fn; },
          onClosed() {},
          onMessage(fn) { this._message = fn; },
          close() {},
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
      attachSession(sid, input) {
        return { sessionId: sid, replay: [], observerId: input.observerId };
      },
      detachObserver(sid, input) {
        detaches.push({
          sid,
          observerId: input.observerId || null,
          socketId: input.socketId || null,
          clientId: input.clientId || null,
          reason: input.reason || null,
        });
      },
      writeInput() {},
      resizeSession() {},
    },
  });

  const live = gateway.acceptOffer({
    socketId: 'sock-dual',
    clientId: 'client-dual',
    offer: { type: 'offer', sdp: 'v=0 offer' },
    onLocalDescription() {},
    onLocalCandidate() {},
  });

  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        live.dc._message?.(JSON.stringify({
          t: 'bind',
          sid: 'term_dual',
          preferDcOutput: true,
        }));
        assert.equal(live.outputObserverId, 'webrtc:sock-dual');
        assert.equal(live.outputAttached, true);

        gateway.closePeer('sock-dual', 'test-close');

        assert.equal(detaches.length, 1);
        assert.equal(detaches[0].observerId, 'webrtc:sock-dual');
        assert.equal(detaches[0].socketId, 'sock-dual');
        assert.equal(detaches[0].clientId, 'client-dual');
        // Exact observerId means presence must not expand to the Socket.IO observer.
        assert.match(detaches[0].reason, /webrtc-/);
        resolve();
      } catch (error) {
        reject(error);
      }
    }, 20);
  });
});
