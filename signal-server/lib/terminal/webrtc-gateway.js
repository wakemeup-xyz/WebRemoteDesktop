const crypto = require('node:crypto');

// Keep parity with Socket.IO terminal input gates in websocket/terminal.js.
const TERMINAL_INPUT_MAX_BYTES = 64 * 1024;
const { assertTerminalSize } = require('./geometry');

function loadNodeDataChannel() {
  try {
    // Optional native dependency; Phase 2 requires it for webrtc-turn.
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    return require('node-datachannel');
  } catch (error) {
    return null;
  }
}

function toNodeIceServers(urls = [], username = '', credential = '') {
  return (Array.isArray(urls) ? urls : [])
    .map((url) => String(url || '').trim())
    .filter(Boolean)
    .map((url) => {
      if (!username || !credential) return url;
      const match = url.match(/^(turns?):([^?]+)(?:\?(.*))?$/i);
      if (!match) return url;
      const scheme = match[1].toLowerCase();
      const hostPort = match[2];
      const query = match[3] ? `?${match[3]}` : '';
      return `${scheme}:${encodeURIComponent(username)}:${encodeURIComponent(credential)}@${hostPort}${query}`;
    });
}

function createTerminalWebRtcGateway(options = {}) {
  const config = options.config || {};
  const logger = options.logger || console;
  const sessionManager = options.sessionManager;
  const audit = options.audit || { info() {}, warn() {}, error() {} };
  const metricNow = typeof options.metricNow === 'function' ? options.metricNow : () => Date.now();
  // Explicit null means “force unavailable” (tests); undefined falls back to runtime.
  const PeerConnectionImpl = Object.prototype.hasOwnProperty.call(options, 'PeerConnection')
    ? options.PeerConnection
    : (loadNodeDataChannel()?.PeerConnection || null);

  /** @type {Map<string, any>} */
  const peers = new Map();

  function available() {
    return Boolean(PeerConnectionImpl)
      && Array.isArray(config.turnUrls)
      && config.turnUrls.length > 0
      && Boolean(config.turnUsername)
      && Boolean(config.turnCredential);
  }

  function capability() {
    return {
      available: available(),
      reason: available()
        ? 'ready'
        : (!PeerConnectionImpl
          ? 'node-datachannel-missing'
          : 'turn-not-configured'),
      iceTransportPolicy: 'relay',
    };
  }

  function peerKey(socketId) {
    return String(socketId || '');
  }

  function detachOutputBridge(entry, reason = 'detach') {
    if (!entry || !sessionManager || typeof sessionManager.detachObserver !== 'function') {
      return;
    }
    const observerId = entry.outputObserverId;
    if (!observerId) return;
    try {
      sessionManager.detachObserver(entry.sessionId || entry.boundSessionId, {
        observerId,
        clientId: entry.clientId,
        socketId: entry.socketId,
        reason: `webrtc-${reason}`,
      });
    } catch (_err) {
      // Session may already be gone.
    }
    entry.outputObserverId = '';
    entry.outputAttached = false;
  }

  function closePeer(socketId, reason = 'close') {
    const key = peerKey(socketId);
    const entry = peers.get(key);
    if (!entry) return;
    peers.delete(key);
    detachOutputBridge(entry, reason);
    try { entry.dc?.close?.(); } catch (_err) { /* ignore */ }
    try { entry.pc?.close?.(); } catch (_err) { /* ignore */ }
    audit.info?.('terminal_webrtc_closed', {
      socketId: key,
      clientId: entry.clientId || null,
      reason,
    });
  }

  function sendJson(dc, payload) {
    if (!dc || typeof dc.sendMessage !== 'function') return false;
    try {
      dc.sendMessage(JSON.stringify(payload));
      return true;
    } catch (error) {
      logger.warn?.('[terminal-webrtc] send failed', error?.message || error);
      return false;
    }
  }

  function handleControlFrame(entry, message) {
    const type = String(message?.t || '');
    if (type === 'ping') {
      sendJson(entry.dc, { t: 'pong', ts: Date.now(), echo: message.ts || null });
      return;
    }
    if (type === 'bind') {
      const previousSid = entry.sessionId;
      entry.sessionId = String(message.sid || entry.sessionId || '');
      // Never trust clientId from DC frames; identity stays socket-authenticated.
      if (typeof message.clientId === 'string' && message.clientId.trim()) {
        entry.browserLabel = String(message.clientId).slice(0, 128);
      }
      entry.preferDcOutput = message.preferDcOutput !== false;
      if (previousSid && previousSid !== entry.sessionId) {
        detachOutputBridge(entry, 'rebind');
      }
      if (entry.sessionId && entry.open) {
        attachOutputBridge(entry);
      }
      sendJson(entry.dc, {
        t: 'bound',
        sid: entry.sessionId,
        ok: Boolean(entry.sessionId),
        output: Boolean(entry.outputAttached),
      });
      return;
    }
    if (!sessionManager) {
      sendJson(entry.dc, { t: 'error', code: 'terminal_session_manager_missing' });
      return;
    }
    if (type === 'in') {
      const sid = String(message.sid || entry.sessionId || '');
      const data = String(message.data || '');
      const inputId = typeof message.inputId === 'string' ? message.inputId : null;
      if (!sid) {
        sendJson(entry.dc, { t: 'error', code: 'terminal_session_required' });
        return;
      }
      const bytes = Buffer.byteLength(data, 'utf8');
      if (bytes > TERMINAL_INPUT_MAX_BYTES) {
        sendJson(entry.dc, {
          t: 'error',
          sid,
          inputId,
          code: 'terminal_input_too_large',
          message: 'Terminal input exceeds 64KB',
          bytes,
          maxBytes: TERMINAL_INPUT_MAX_BYTES,
        });
        return;
      }
      try {
        const started = metricNow();
        sessionManager.writeInput(sid, {
          clientId: entry.clientId,
          socketId: entry.socketId,
          data,
        });
        sendJson(entry.dc, {
          t: 'ack',
          sid,
          inputId,
          serverProcessMs: Math.max(0, Number(metricNow()) - Number(started)),
        });
      } catch (error) {
        sendJson(entry.dc, {
          t: 'error',
          sid,
          inputId,
          code: error.code || 'terminal_input_failed',
          message: error.message,
        });
      }
      return;
    }
    if (type === 'resize') {
      const sid = String(message.sid || entry.sessionId || '');
      let cols;
      let rows;
      try {
        ({ cols, rows } = assertTerminalSize(message.cols, message.rows));
      } catch (error) {
        sendJson(entry.dc, {
          t: 'error',
          sid,
          code: 'terminal_resize_out_of_range',
          message: 'Terminal resize is out of range',
          cols: message.cols,
          rows: message.rows,
        });
        return;
      }
      try {
        sessionManager.resizeSession(sid, {
          clientId: entry.clientId,
          socketId: entry.socketId,
          cols,
          rows,
        });
        sendJson(entry.dc, { t: 'resized', sid });
      } catch (error) {
        const code = error.code === 'terminal_invalid_size'
          ? 'terminal_resize_out_of_range'
          : (error.code || 'terminal_resize_failed');
        sendJson(entry.dc, {
          t: 'error',
          sid,
          code,
          message: error.message,
        });
      }
    }
  }

  function wireDataChannel(entry, dc) {
    entry.dc = dc;
    dc.onOpen?.(() => {
      entry.open = true;
      sendJson(dc, { t: 'ready', transport: 'webrtc-turn' });
      if (entry.sessionId) {
        attachOutputBridge(entry);
      }
      audit.info?.('terminal_webrtc_dc_open', {
        socketId: entry.socketId,
        clientId: entry.clientId || null,
      });
    });
    dc.onClosed?.(() => {
      entry.open = false;
      detachOutputBridge(entry, 'dc-closed');
    });
    dc.onMessage?.((msg) => {
      let parsed = msg;
      if (typeof msg === 'string') {
        try {
          parsed = JSON.parse(msg);
        } catch (_err) {
          sendJson(dc, { t: 'error', code: 'terminal_webrtc_bad_json' });
          return;
        }
      }
      handleControlFrame(entry, parsed);
    });
  }

  function attachOutputBridge(entry) {
    if (!entry?.sessionId || !sessionManager || typeof sessionManager.attachSession !== 'function') {
      return entry;
    }
    if (entry.outputAttached && entry.outputObserverId) {
      return entry;
    }
    // Dedicated observer id so Socket.IO observer and DC observer can coexist.
    // Client suppresses Socket.IO terminal:output while DC is preferred, avoiding double-write.
    const observerId = `webrtc:${entry.socketId}`;
    try {
      sessionManager.attachSession(entry.sessionId, {
        clientId: entry.clientId || entry.socketId,
        socketId: entry.socketId,
        observerId,
        onData(data, metadata = {}, acknowledge) {
          if (!entry.open || !entry.dc) {
            if (typeof acknowledge === 'function') acknowledge();
            return;
          }
          const ok = sendJson(entry.dc, {
            t: 'out',
            sid: entry.sessionId,
            data: String(data || ''),
            replaySeq: metadata.replaySeq,
          });
          if (typeof acknowledge === 'function') acknowledge();
          if (!ok) {
            // Backpressure / closed channel: detach DC output so Socket path can resume.
            detachOutputBridge(entry, 'send-failed');
            sendJson(entry.dc, {
              t: 'output_fallback',
              sid: entry.sessionId,
              code: 'terminal_webrtc_output_send_failed',
            });
          }
        },
        onExit(payload = {}) {
          sendJson(entry.dc, {
            t: 'exit',
            sid: entry.sessionId,
            exitCode: payload.exitCode ?? null,
            signal: payload.signal || null,
            processStatus: payload.processStatus || null,
          });
        },
        onError(error = {}) {
          sendJson(entry.dc, {
            t: 'error',
            sid: entry.sessionId,
            code: error.code || 'terminal_error',
            message: error.message || '',
          });
        },
        onWarning(warning = {}) {
          sendJson(entry.dc, {
            t: 'warning',
            sid: entry.sessionId,
            code: warning.code || 'terminal_warning',
            message: warning.message || '',
          });
        },
      });
      entry.outputObserverId = observerId;
      entry.outputAttached = true;
      sendJson(entry.dc, {
        t: 'output_bound',
        sid: entry.sessionId,
        observerId,
      });
    } catch (error) {
      entry.outputAttached = false;
      entry.outputObserverId = '';
      sendJson(entry.dc, {
        t: 'error',
        sid: entry.sessionId,
        code: error.code || 'terminal_webrtc_output_bind_failed',
        message: error.message || '',
      });
    }
    return entry;
  }

  function acceptOffer({
    socketId,
    clientId,
    offer,
    onLocalDescription,
    onLocalCandidate,
  }) {
    if (!available()) {
      const err = new Error(capability().reason);
      err.code = capability().reason;
      throw err;
    }
    const key = peerKey(socketId);
    closePeer(key, 'replace');

    const iceServers = toNodeIceServers(
      config.turnUrls,
      config.turnUsername,
      config.turnCredential,
    );
    const pc = new PeerConnectionImpl(`term-${crypto.randomBytes(4).toString('hex')}`, {
      iceServers,
      iceTransportPolicy: 'relay',
    });
    const entry = {
      pc,
      dc: null,
      open: false,
      socketId: key,
      // Immutable peer identity from authenticated terminal socket offer path.
      clientId: String(clientId || ''),
      browserLabel: '',
      sessionId: '',
    };
    peers.set(key, entry);

    pc.onLocalDescription?.((sdp, type) => {
      onLocalDescription?.({ sdp, type });
    });
    pc.onLocalCandidate?.((candidate, mid) => {
      if (!candidate) return;
      onLocalCandidate?.({ candidate, mid: mid || '0' });
    });
    pc.onDataChannel?.((dc) => {
      wireDataChannel(entry, dc);
      attachOutputBridge(entry);
    });

    const sdp = offer?.sdp || offer;
    const type = offer?.type || 'offer';
    if (!sdp) {
      closePeer(key, 'missing-offer');
      const err = new Error('missing offer sdp');
      err.code = 'terminal_webrtc_missing_offer';
      throw err;
    }
    pc.setRemoteDescription(String(sdp), String(type));
    return entry;
  }

  function addRemoteCandidate(socketId, candidateLike = {}) {
    const entry = peers.get(peerKey(socketId));
    if (!entry?.pc) return false;
    const candidate = candidateLike.candidate || candidateLike;
    const mid = candidateLike.mid || '0';
    if (!candidate) return false;
    try {
      entry.pc.addRemoteCandidate(String(candidate), String(mid));
      return true;
    } catch (error) {
      logger.warn?.('[terminal-webrtc] addRemoteCandidate failed', error?.message || error);
      return false;
    }
  }

  function getPeer(socketId) {
    return peers.get(peerKey(socketId)) || null;
  }

  function closeAll(reason = 'shutdown') {
    for (const key of [...peers.keys()]) {
      closePeer(key, reason);
    }
  }

  return {
    available,
    capability,
    acceptOffer,
    addRemoteCandidate,
    closePeer,
    closeAll,
    getPeer,
    toNodeIceServers,
  };
}

module.exports = {
  TERMINAL_INPUT_MAX_BYTES,
  // Compatibility re-exports for tests/callers that imported gateway size constants.
  TERMINAL_RESIZE_COLS_MIN: require('./geometry').COLS_LIMIT.min,
  TERMINAL_RESIZE_COLS_MAX: require('./geometry').COLS_LIMIT.max,
  TERMINAL_RESIZE_ROWS_MIN: require('./geometry').ROWS_LIMIT.min,
  TERMINAL_RESIZE_ROWS_MAX: require('./geometry').ROWS_LIMIT.max,
  createTerminalWebRtcGateway,
  loadNodeDataChannel,
  toNodeIceServers,
};
