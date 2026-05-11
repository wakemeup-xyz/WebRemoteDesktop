const LatencyMonitor = {
  // Clock sync state
  _offsetMs: 0,
  _rttMs: 0,
  _syncState: 'idle', // idle, syncing, synced
  _lastSyncAt: 0,
  _syncV0: 0,

  // Input tracking
  _inputMap: new Map(), // inputId -> { i0, ts }

  // Statistics (5-second sliding window)
  _windowMs: 5000,
  _stats: {
    capture: [],
    scale: [],
    encode: [],
    network: [],
    playout: [],
    inputRtt: [],
  },

  init() {
    console.log('[LatencyMonitor] initialized');
  },

  // ─── Clock Sync ───

  requestClockSync() {
    if (this._syncState === 'syncing') return;
    this._syncState = 'syncing';

    const v0 = performance.now();
    this._syncV0 = v0;

    if (typeof WebRTC !== 'undefined' && WebRTC.inputChannel && WebRTC.inputChannel.readyState === 'open') {
      WebRTC.inputChannel.send(JSON.stringify({
        type: 'clock_sync_req',
        v0: v0,
      }));
    } else {
      this._syncState = 'idle';
    }
  },

  handleClockSyncResponse(data) {
    const v1 = performance.now();
    const v0 = this._syncV0;
    const h0 = data.h0;
    const h1 = data.h1;

    const h0ms = h0 * 1000;
    const h1ms = h1 * 1000;

    const rtt = (v1 - v0) - (h1ms - h0ms);
    const offset = ((h0ms - v0) + (h1ms - v1)) / 2;

    this._rttMs = rtt;
    this._offsetMs = offset;
    this._syncState = 'synced';
    this._lastSyncAt = Date.now();

    console.log('[LatencyMonitor] Clock synced: RTT=', rtt.toFixed(1), 'ms, offset=', offset.toFixed(1), 'ms');
  },

  // ─── Frame Timing ───

  onFrameTiming(data) {
    const now = performance.now();
    const timings = data.timings;

    const hostToViewer = (hostSec) => hostSec * 1000 + this._offsetMs;

    const t0v = hostToViewer(timings.captureStart);
    const t1v = hostToViewer(timings.captureEnd);
    const t2v = hostToViewer(timings.scaleEnd);
    const t3v = hostToViewer(timings.encodeEnd);
    const t4v = hostToViewer(timings.packetSend);
    const t5v = now;

    this._pushStat('capture', t1v - t0v);
    this._pushStat('scale', t2v - t1v);
    this._pushStat('encode', t3v - t2v);
    this._pushStat('network', t5v - t4v);

    if (data.inputIds && data.inputIds.length > 0) {
      for (const inputId of data.inputIds) {
        const inputRecord = this._inputMap.get(inputId);
        if (inputRecord) {
          this._pushStat('inputRtt', t5v - inputRecord.i0);
          this._inputMap.delete(inputId);
        }
      }
    }
  },

  // ─── Input Tracking ───

  recordInputSend(inputId) {
    this._inputMap.set(inputId, { i0: performance.now(), ts: Date.now() });
    // Cleanup old entries
    const cutoff = Date.now() - 10000;
    for (const [id, rec] of this._inputMap) {
      if (rec.ts < cutoff) this._inputMap.delete(id);
    }
  },

  // ─── Video Frame / Playout Buffer ───

  onVideoFrame(now, metadata) {
    // T6: frame decoded and ready to render
    const t6 = now;
    // T5 is approximated by when the frame timing data arrived
    // We use the most recent network stat as T5 proxy
    const networkStats = this._stats.network;
    if (networkStats.length > 0) {
      const lastNetwork = networkStats[networkStats.length - 1].value;
      // Estimate T5 = T6 - playoutBuffer
      // We don't have exact T5, so we estimate playout buffer from getStats
      this._estimatePlayoutBuffer();
    }
  },

  async _estimatePlayoutBuffer() {
    if (typeof WebRTC === 'undefined' || !WebRTC.pc) return;
    try {
      const stats = await WebRTC.pc.getStats();
      let jitterBufferDelay = 0;
      let jitterBufferEmittedCount = 0;
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          jitterBufferDelay = report.jitterBufferDelay || 0;
          jitterBufferEmittedCount = report.jitterBufferEmittedCount || 1;
        }
      });
      if (jitterBufferEmittedCount > 0) {
        const avgPlayoutMs = (jitterBufferDelay / jitterBufferEmittedCount) * 1000;
        this._pushStat('playout', avgPlayoutMs);
      }
    } catch (e) {
      // ignore
    }
  },

  // ─── Statistics ───

  _pushStat(key, value) {
    const arr = this._stats[key];
    if (!arr) return;
    arr.push({ value, ts: Date.now() });
    const cutoff = Date.now() - this._windowMs;
    while (arr.length > 0 && arr[0].ts < cutoff) {
      arr.shift();
    }
  },

  getStats() {
    const calc = (arr) => {
      if (!arr || arr.length === 0) return { p50: 0, p95: 0, count: 0 };
      const sorted = arr.map(x => x.value).sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];
      return { p50, p95, count: sorted.length };
    };

    return {
      capture: calc(this._stats.capture),
      scale: calc(this._stats.scale),
      encode: calc(this._stats.encode),
      network: calc(this._stats.network),
      playout: calc(this._stats.playout),
      inputRtt: calc(this._stats.inputRtt),
      sync: {
        state: this._syncState,
        rtt: this._rttMs,
        offset: this._offsetMs,
      },
    };
  },
};
