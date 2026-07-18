const LatencyMonitor = {
  // Clock sync state
  _offsetMs: 0,
  _rttMs: 0,
  _syncState: 'idle', // idle, syncing, synced
  _lastSyncAt: 0,
  _syncV0: 0,

  // Input tracking
  _inputMap: new Map(), // inputId -> { i0, ts }
  _visualInputMap: new Map(), // inputId -> { i0, ts }

  // Playout buffer tracking (delta calculation)
  _lastJitterDelay: 0,
  _lastJitterEmitted: 0,

  // Statistics (5-second sliding window)
  _windowMs: 5000,
  _stats: {
    capture: [],
    scale: [],
    encode: [],
    network: [],
    playout: [],
    inputRtt: [],
    executeTime: [],
    visualFeedback: [],
    paint: [],
  },

  init() {
    console.log('[LatencyMonitor] initialized');
  },

  // ─── Clock Sync ───

  requestClockSync() {
    if (this._syncState === 'syncing') return;
    this._syncState = 'syncing';

    const v0 = Date.now();
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
    const v1 = Date.now();
    const v0 = this._syncV0;
    const h0 = data.h0;
    const h1 = data.h1;

    const h0ms = h0 * 1000;
    const h1ms = h1 * 1000;

    const rtt = (v1 - v0) - (h1ms - h0ms);
    const offset = (v0 + v1) / 2 - (h0ms + h1ms) / 2;

    this._rttMs = rtt;
    this._offsetMs = offset;
    this._syncState = 'synced';
    this._lastSyncAt = Date.now();

    console.log('[LatencyMonitor] Clock synced: RTT=', rtt.toFixed(1), 'ms, offset=', offset.toFixed(1), 'ms');
  },

  // ─── Frame Timing ───

  onFrameTiming(data) {
    const now = Date.now();
    const timings = data.timings || {};

    if (data.schemaVersion === 2) {
      if (Number.isFinite(Number(timings.capturePrepareMs))) {
        this._pushStat('capture', Number(timings.capturePrepareMs));
      }
      if (Number.isFinite(Number(timings.frameConvertMs))) {
        this._pushStat('scale', Number(timings.frameConvertMs));
      }
      if (timings.encoderMs != null && Number.isFinite(Number(timings.encoderMs))) {
        this._pushStat('encode', Number(timings.encoderMs));
      }
    } else {
      const hostToViewer = (hostSec) => hostSec * 1000 + this._offsetMs;
      const t0v = hostToViewer(timings.captureStart);
      const t1v = hostToViewer(timings.captureEnd);
      const t2v = hostToViewer(timings.scaleEnd);
      const t3v = hostToViewer(timings.encodeEnd);
      const t4v = hostToViewer(timings.packetSend);
      this._pushStat('capture', t1v - t0v);
      this._pushStat('scale', t2v - t1v);
      this._pushStat('encode', t3v - t2v);
      this._pushStat('network', now - t4v);
    }

    // Process input timing data from host (receiveTime, executeTime)
    const inputs = data.inputs;
    if (inputs && inputs.length > 0) {
      for (const inp of inputs) {
        if (inp.receiveTime != null && inp.executeTime != null) {
          this._pushStat('executeTime', (inp.executeTime - inp.receiveTime) * 1000);
        }
      }
    }

    // Frame-bound input IDs represent visual feedback, not transport ack RTT.
    if (data.inputIds && data.inputIds.length > 0) {
      for (const inputId of data.inputIds) {
        const visualRecord = this._visualInputMap.get(inputId);
        if (visualRecord) {
          this._pushStat('visualFeedback', now - visualRecord.i0);
          this._visualInputMap.delete(inputId);
        }
        // Compatibility with an older Host that has no independent input_ack.
        const inputRecord = this._inputMap.get(inputId);
        if (inputRecord) {
          this._pushStat('inputRtt', now - inputRecord.i0);
          this._inputMap.delete(inputId);
        }
      }
    }

  },

  // ─── Input Tracking ───

  recordInputSend(inputId) {
    const now = Date.now();
    this._inputMap.set(inputId, { i0: now, ts: now });
    this._visualInputMap.set(inputId, { i0: now, ts: now });
    // Cleanup old entries every 10 calls instead of every call to avoid O(n) loop on hot path
    this._inputCleanupCounter = (this._inputCleanupCounter || 0) + 1;
    if (this._inputCleanupCounter >= 10) {
      this._inputCleanupCounter = 0;
      const cutoff = now - 10000;
      for (const [id, rec] of this._inputMap) {
        if (rec.ts < cutoff) this._inputMap.delete(id);
      }
      for (const [id, rec] of this._visualInputMap) {
        if (rec.ts < cutoff) this._visualInputMap.delete(id);
      }
    }
  },

  onInputAck(data = {}) {
    const now = Date.now();
    const inputIds = Array.isArray(data.inputIds) ? data.inputIds : [];
    for (const inputId of inputIds) {
      const inputRecord = this._inputMap.get(inputId);
      if (!inputRecord) continue;
      this._pushStat('inputRtt', Math.max(0, now - inputRecord.i0));
      this._inputMap.delete(inputId);
    }
    const hostExecuteMs = Number(data.hostExecuteMs);
    if (Number.isFinite(hostExecuteMs) && hostExecuteMs >= 0) {
      this._pushStat('executeTime', hostExecuteMs);
    }
  },

  // ─── Video Frame / Playout Buffer ───

  onVideoFrame(now, metadata) {
    if (this._lastPaintAt != null && Number.isFinite(Number(now))) {
      this._pushStat('paint', Math.max(0, Number(now) - this._lastPaintAt));
    }
    this._lastPaintAt = Number(now);
  },

  onMediaStats(snapshot = {}) {
    const jitterBufferMs = Number(snapshot.jitterBufferMs);
    if (Number.isFinite(jitterBufferMs) && jitterBufferMs >= 0 && jitterBufferMs < 5000) {
      this._pushStat('playout', jitterBufferMs);
    }
  },

  // ─── Statistics ───

  _pushStat(key, value) {
    const arr = this._stats[key];
    if (!arr) return;
    const now = Date.now();
    const cutoff = now - this._windowMs;

    // Fast path: if head is fresh, skip cleanup entirely
    if (arr.length === 0 || arr[0].ts >= cutoff) {
      arr.push({ value, ts: now });
      return;
    }

    // Batch-remove expired entries with a single splice instead of O(n) shift loop
    let start = 1;
    const len = arr.length;
    while (start < len && arr[start].ts < cutoff) {
      start++;
    }
    arr.splice(0, start);
    arr.push({ value, ts: now });
  },

  getStats() {
    const calc = (arr) => {
      if (!arr || arr.length === 0) return { last: null, p50: null, p95: null, count: 0, available: false };
      // QuickSelect-style partition for p50/p95: O(n) instead of O(n log n) sort
      const values = arr.map(x => x.value);
      const n = values.length;
      const p50Idx = Math.floor(n * 0.5);
      const p95Idx = Math.floor(n * 0.95);
      const p50 = this._quickSelect(values, p50Idx);
      const p95 = p95Idx >= n ? values[this._quickSelect(values, n - 1, true)] : this._quickSelect(values, p95Idx);
      return { last: arr.at(-1).value, p50, p95, count: n, available: true };
    };

    return {
      capture: calc(this._stats.capture),
      scale: calc(this._stats.scale),
      encode: calc(this._stats.encode),
      network: calc(this._stats.network),
      playout: calc(this._stats.playout),
      inputRtt: calc(this._stats.inputRtt),
      executeTime: calc(this._stats.executeTime),
      visualFeedback: calc(this._stats.visualFeedback),
      paint: calc(this._stats.paint),
      sync: {
        state: this._syncState,
        rtt: this._rttMs,
        offset: this._offsetMs,
      },
    };
  },

  // QuickSelect: find k-th smallest element in O(n) average, O(n^2) worst.
  // For our small arrays (n < 200) this is faster than sort() because it avoids
  // the full O(n log n) overhead and temporary array creation.
  _quickSelect(arr, k, returnIndex = false) {
    let left = 0;
    let right = arr.length - 1;
    while (left < right) {
      const pivot = arr[right];
      let store = left;
      for (let i = left; i < right; i++) {
        if (arr[i] < pivot) {
          const tmp = arr[i];
          arr[i] = arr[store];
          arr[store] = tmp;
          store++;
        }
      }
      const tmp = arr[store];
      arr[store] = arr[right];
      arr[right] = tmp;
      if (store === k) break;
      if (store < k) left = store + 1;
      else right = store - 1;
    }
    return returnIndex ? left : arr[k];
  },
};
