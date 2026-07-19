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
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.remainingBytes = this.burstBytes;
    this.lastRefillAt = Number(this.now());
    if (!Number.isFinite(this.lastRefillAt)) this.lastRefillAt = 0;
  }

  refill() {
    const currentTime = Number(this.now());
    if (!Number.isFinite(currentTime) || currentTime <= this.lastRefillAt) return;
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
    this.schedule = typeof options.schedule === 'function' ? options.schedule : setImmediate;
    this.observers = new Map();
    this.drainScheduled = false;
    this.draining = false;
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
    observer.queue.push({ data: normalizedData, metadata });
    observer.queuedBytes += bytes;
    this.ensureDrainScheduled();
    return true;
  }

  detach(observerId) {
    return this.observers.delete(String(observerId || '').trim());
  }

  queuedBytes(observerId) {
    return this.observers.get(String(observerId || '').trim())?.queuedBytes || 0;
  }

  ensureDrainScheduled() {
    if (this.drainScheduled || this.draining) return;
    this.drainScheduled = true;
    this.schedule(() => this.drain());
  }

  drain() {
    if (this.draining) return;
    this.drainScheduled = false;
    this.draining = true;
    for (const [observerId, observer] of this.observers.entries()) {
      while (this.observers.get(observerId) === observer && observer.queue.length > 0) {
        const chunk = observer.queue.shift();
        observer.queuedBytes -= byteLength(chunk.data);
        observer.callbacks.onData?.(chunk.data, chunk.metadata);
      }
    }
    this.draining = false;
    if (Array.from(this.observers.values()).some((observer) => observer.queue.length > 0)) {
      this.ensureDrainScheduled();
    }
  }
}

module.exports = {
  TerminalInputBucket,
  TerminalOutputDispatcher,
};
