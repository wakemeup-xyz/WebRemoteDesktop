function positiveNumber(name, value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
  return normalized;
}

function byteLength(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('byte count must be a non-negative number');
    }
    return value;
  }
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

class TerminalInputBucket {
  constructor(options = {}) {
    this.bytesPerSecond = positiveNumber('bytesPerSecond', options.bytesPerSecond);
    this.burstBytes = positiveNumber('burstBytes', options.burstBytes);
    this.now = typeof options.now === 'function' ? options.now : () => performance.now();
    this.remainingBytes = this.burstBytes;
    this.lastRefillAt = Number(this.now());
    if (!Number.isFinite(this.lastRefillAt)) this.lastRefillAt = 0;
  }

  refill() {
    const currentTime = Number(this.now());
    if (!Number.isFinite(currentTime)) return;
    if (currentTime < this.lastRefillAt) {
      this.lastRefillAt = currentTime;
      return;
    }
    if (currentTime === this.lastRefillAt) return;
    const elapsedMs = currentTime - this.lastRefillAt;
    this.lastRefillAt = currentTime;
    this.remainingBytes = Math.min(
      this.burstBytes,
      this.remainingBytes + ((elapsedMs * this.bytesPerSecond) / 1000),
    );
  }

  consume(value) {
    const bytes = byteLength(value);
    this.refill();
    if (bytes <= this.remainingBytes) {
      this.remainingBytes -= bytes;
      return {
        accepted: true,
        retryAfterMs: 0,
        remainingBytes: this.remainingBytes,
      };
    }
    return {
      accepted: false,
      retryAfterMs: Math.ceil(((bytes - this.remainingBytes) * 1000) / this.bytesPerSecond),
      remainingBytes: this.remainingBytes,
    };
  }

  snapshot() {
    this.refill();
    return {
      bytesPerSecond: this.bytesPerSecond,
      burstBytes: this.burstBytes,
      remainingBytes: this.remainingBytes,
    };
  }
}

class TerminalOutputDispatcher {
  constructor(options = {}) {
    this.maxQueueBytes = positiveNumber('maxQueueBytes', options.maxQueueBytes);
    // Windowed delivery: allow multiple unacked chunks in flight so high-RTT
    // tunnels (Cloudflare) do not serialize every tiny PTY write behind one RTT.
    // maxInFlightChunks=1 restores classic stop-and-wait behavior.
    this.maxInFlightChunks = options.maxInFlightChunks === undefined
      ? 32
      : positiveNumber('maxInFlightChunks', options.maxInFlightChunks);
    this.maxInFlightBytes = options.maxInFlightBytes === undefined
      ? 65536
      : positiveNumber('maxInFlightBytes', options.maxInFlightBytes);
    this.schedule = typeof options.schedule === 'function' ? options.schedule : setImmediate;
    this.observers = new Map();
  }

  attach(observerId, callbacks = {}) {
    const normalizedId = String(observerId || '').trim();
    if (!normalizedId) throw new TypeError('observerId is required');
    const existing = this.observers.get(normalizedId);
    if (existing) {
      existing.callbacks = callbacks;
      return;
    }
    this.observers.set(normalizedId, {
      callbacks,
      queue: [],
      queuedBytes: 0,
      droppedChunks: 0,
      warned: false,
      scheduled: false,
      draining: false,
      inFlight: new Map(),
      inFlightBytes: 0,
      nextChunkId: 1,
    });
  }

  enqueue(observerId, data, metadata = {}) {
    const normalizedId = String(observerId || '').trim();
    const observer = this.observers.get(normalizedId);
    if (!observer) return false;
    const normalizedData = String(data ?? '');
    const bytes = byteLength(normalizedData);
    if (observer.queuedBytes + bytes > this.maxQueueBytes) {
      observer.droppedChunks += 1;
      const stats = Object.freeze({
        queuedBytes: observer.queuedBytes,
        droppedChunks: observer.droppedChunks,
      });
      if (!observer.warned) {
        observer.warned = true;
        observer.callbacks.onWarning?.({
          code: 'terminal_output_backpressure',
          stats,
        });
      }
      this.observers.delete(normalizedId);
      observer.callbacks.onDetach?.('output-backpressure', stats);
      return false;
    }
    observer.queue.push({ data: normalizedData, metadata, bytes, acknowledged: false });
    observer.queuedBytes += bytes;
    this.ensureDrainScheduled(normalizedId, observer);
    return true;
  }

  detach(observerId) {
    return this.observers.delete(String(observerId || '').trim());
  }

  queuedBytes(observerId) {
    return this.observers.get(String(observerId || '').trim())?.queuedBytes || 0;
  }

  canSendMore(observer) {
    if (observer.queue.length === 0) return false;
    // Always allow at least one in-flight chunk so oversized single writes cannot stall.
    if (observer.inFlight.size === 0) return true;
    if (observer.inFlight.size >= this.maxInFlightChunks) return false;
    if (observer.inFlightBytes >= this.maxInFlightBytes) return false;
    return true;
  }

  ensureDrainScheduled(observerId, observer) {
    if (
      this.observers.get(observerId) !== observer
      || observer.scheduled
      || observer.draining
      || !this.canSendMore(observer)
    ) {
      return;
    }
    observer.scheduled = true;
    this.schedule(() => this.drain(observerId, observer));
  }

  drain(observerId, observer) {
    if (this.observers.get(observerId) !== observer) return;
    observer.scheduled = false;
    if (observer.draining || !this.canSendMore(observer)) return;

    observer.draining = true;
    try {
      while (this.canSendMore(observer)) {
        const chunk = observer.queue.shift();
        if (!chunk) break;
        const chunkId = observer.nextChunkId;
        observer.nextChunkId += 1;
        observer.inFlight.set(chunkId, chunk);
        observer.inFlightBytes += chunk.bytes;
        const acknowledge = () => {
          if (chunk.acknowledged) return;
          chunk.acknowledged = true;
          if (this.observers.get(observerId) !== observer) return;
          if (!observer.inFlight.has(chunkId)) return;
          observer.inFlight.delete(chunkId);
          observer.inFlightBytes = Math.max(0, observer.inFlightBytes - chunk.bytes);
          observer.queuedBytes = Math.max(0, observer.queuedBytes - chunk.bytes);
          if (!observer.draining) this.ensureDrainScheduled(observerId, observer);
        };
        const onData = observer.callbacks.onData;
        const autoAcknowledge = typeof onData !== 'function' || onData.length < 3;
        try {
          onData?.(chunk.data, chunk.metadata, acknowledge);
        } finally {
          if (autoAcknowledge) acknowledge();
        }
      }
    } finally {
      observer.draining = false;
      this.ensureDrainScheduled(observerId, observer);
    }
  }
}

module.exports = {
  TerminalInputBucket,
  TerminalOutputDispatcher,
};
const { performance } = require('node:perf_hooks');
