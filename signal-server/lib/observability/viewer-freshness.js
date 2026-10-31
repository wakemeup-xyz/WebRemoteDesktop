'use strict';

// Bounded, metadata-only liveness observation for desktop viewers. This module
// never owns sockets or lease credentials; the caller decides whether a stale
// viewer may be removed after the evidence event is emitted.

const MAX_COUNT = 999999999;
const DEFAULT_STALE_AFTER_MS = 120000;
const MIN_STALE_AFTER_MS = 30000;
const MAX_STALE_AFTER_MS = 3600000;
const DEFAULT_ACTIVE_RECOVERY_AFTER_MS = 240000;
const MAX_ACTIVE_RECOVERY_AFTER_MS = 7200000;

function finiteTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function boundedAge(now, value) {
  const at = finiteTime(now);
  const previous = finiteTime(value);
  if (at === null || previous === null || previous > at) return null;
  return Math.min(MAX_COUNT, Math.floor(at - previous));
}

function boundedNonnegative(value, fallback = null) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(MAX_COUNT, Math.floor(value)));
}

function normalizeStaleAfter(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_STALE_AFTER_MS;
  return Math.max(MIN_STALE_AFTER_MS, Math.min(MAX_STALE_AFTER_MS, Math.floor(parsed)));
}

function normalizeActiveRecoveryAfter(value, staleAfterMs) {
  const parsed = Number(value);
  const fallback = Math.max(DEFAULT_ACTIVE_RECOVERY_AFTER_MS, staleAfterMs * 2);
  if (!Number.isFinite(parsed)) return Math.min(MAX_ACTIVE_RECOVERY_AFTER_MS, fallback);
  return Math.max(staleAfterMs, Math.min(MAX_ACTIVE_RECOVERY_AFTER_MS, Math.floor(parsed)));
}

function createViewerFreshnessRegistry(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const staleAfterMs = normalizeStaleAfter(options.staleAfterMs);
  const activeRecoveryAfterMs = normalizeActiveRecoveryAfter(options.activeRecoveryAfterMs, staleAfterMs);
  const activeReleaseAfterMs = Math.min(MAX_ACTIVE_RECOVERY_AFTER_MS,
    activeRecoveryAfterMs + staleAfterMs);
  const tickMs = Math.max(1000, Math.min(60000, boundedNonnegative(options.tickMs, 1000)));
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const viewers = new Map();
  let timer = null;
  let stopped = false;

  function readNow() {
    try { return finiteTime(now()); } catch { return null; }
  }

  function snapshot(viewer) {
    const at = readNow();
    const lastActivityAt = [viewer.lastStatsAt, viewer.lastHeartbeatAt, viewer.lastMediaAt]
      .filter(value => finiteTime(value) !== null)
      .reduce((latest, value) => Math.max(latest, value), null);
    const lastProgressAt = [viewer.lastMediaAt, viewer.lastMediaAckAt, viewer.lastDecodedAt,
      viewer.lastReceivedAt, viewer.lastHeartbeatAt]
      .filter(value => finiteTime(value) !== null)
      .reduce((latest, value) => Math.max(latest, value), null);
    return {
      state: viewer.mediaState,
      mediaState: viewer.mediaState,
      pageVisibility: viewer.pageVisibility,
      pageHidden: viewer.pageVisibility === 'hidden',
      stale: viewer.staleEmitted,
      released: viewer.released,
      generation: viewer.generation,
      lastFrameAgeMs: boundedAge(at, viewer.lastDecodedAt),
      lastReceivedAgeMs: boundedAge(at, viewer.lastReceivedAt),
      lastStatsAgeMs: boundedAge(at, viewer.lastStatsAt),
      lastHeartbeatAgeMs: boundedAge(at, viewer.lastHeartbeatAt),
      lastMediaAckAgeMs: boundedAge(at, viewer.lastMediaAckAt),
      mediaStateAgeMs: boundedAge(at, viewer.lastMediaAt),
      activityAgeMs: boundedAge(at, lastActivityAt),
      progressAgeMs: boundedAge(at, lastProgressAt),
      suspendedAgeMs: boundedAge(at, viewer.suspendedSince),
      activeStallAgeMs: boundedAge(at, viewer.activeStallSince),
      activeRecoveryAfterMs,
      activeRecoveryRequested: viewer.activeRecoveryEmitted,
      staleAfterMs,
    };
  }

  function event(viewer, name, meta = {}) {
    try { options.onEvent?.({ event: name, viewerId: viewer.viewerId, meta: { ...snapshot(viewer), ...meta } }); }
    catch { /* Observability must not affect socket or lease operations. */ }
  }

  function ensure(viewerId) {
    if (typeof viewerId !== 'string' || viewerId.length === 0) return null;
    let viewer = viewers.get(viewerId);
    if (!viewer) {
      const at = readNow();
      viewer = {
        viewerId, mediaState: 'unknown', pageVisibility: 'unknown', generation: null,
        lastMediaAt: at, lastStatsAt: null, lastHeartbeatAt: null,
        lastDecodedAt: null, lastReceivedAt: null, suspendedSince: null,
        mediaStalledEmitted: false, staleEmitted: false, released: false,
        activeStallSince: null, activeRecoveryEmitted: false, lastMediaAckAt: null,
      };
      viewers.set(viewerId, viewer);
    }
    return viewer;
  }

  function publish(viewer) {
    try { options.onSnapshot?.(viewer.viewerId, snapshot(viewer)); } catch { /* best effort */ }
  }

  function evaluate(viewer, at = readNow()) {
    if (!viewer || at === null || viewer.released) return;
    const suspendedAge = boundedAge(at, viewer.suspendedSince);
    const frameAge = boundedAge(at, viewer.lastDecodedAt);
    const statsAge = boundedAge(at, viewer.lastStatsAt);
    const heartbeatAge = boundedAge(at, viewer.lastHeartbeatAt);
    const progressAt = [viewer.lastMediaAt, viewer.lastMediaAckAt, viewer.lastDecodedAt,
      viewer.lastReceivedAt, viewer.lastHeartbeatAt]
      .filter(value => finiteTime(value) !== null)
      .reduce((latest, value) => Math.max(latest, value), null);
    const progressAge = boundedAge(at, progressAt);
    const hiddenSuspended = viewer.mediaState === 'suspended'
      && viewer.pageVisibility === 'hidden'
      && suspendedAge !== null
      && suspendedAge >= staleAfterMs;
    const activeStalled = viewer.mediaState === 'active'
      && ((frameAge !== null && frameAge >= staleAfterMs)
        || (viewer.lastDecodedAt === null && statsAge !== null && statsAge >= staleAfterMs));

    if ((hiddenSuspended || activeStalled) && !viewer.mediaStalledEmitted) {
      viewer.mediaStalledEmitted = true;
      if (activeStalled && viewer.activeStallSince === null) viewer.activeStallSince = at;
      event(viewer, 'media_stalled', {
        reason: hiddenSuspended ? 'page-hidden' : 'no-fresh-frame',
        lastFrameAgeMs: frameAge,
        lastProgressAgeMs: progressAge,
        suspendedAgeMs: suspendedAge,
      });
    }
    if (activeStalled && viewer.activeStallSince === null) viewer.activeStallSince = at;
    const activeStallAge = boundedAge(at, viewer.activeStallSince);
    if (activeStalled && activeStallAge !== null && activeStallAge >= activeRecoveryAfterMs
      && !viewer.activeRecoveryEmitted) {
      viewer.activeRecoveryEmitted = true;
      event(viewer, 'media_stall_recovery_requested', {
        reason: 'no-fresh-frame', lastFrameAgeMs: frameAge, lastProgressAgeMs: progressAge,
        recoveryAfterMs: activeRecoveryAfterMs,
      });
      try { options.onActiveStall?.({ viewerId: viewer.viewerId, snapshot: snapshot(viewer) }); }
      catch { /* Recovery observation must not affect socket or lease operations. */ }
    }
    // Active media is released only after a recovery opportunity and a second
    // bounded window with no progress. This avoids treating a transient pause
    // as a dead session.
    if (activeStalled && activeStallAge !== null && activeStallAge >= activeReleaseAfterMs
      && viewer.activeRecoveryEmitted && !viewer.staleEmitted
      && (progressAge === null || progressAge >= staleAfterMs)) {
      viewer.staleEmitted = true;
      event(viewer, 'session_stale_detected', {
        reason: 'active-no-fresh-frame', lastFrameAgeMs: frameAge,
        lastProgressAgeMs: progressAge, recoveryAfterMs: activeRecoveryAfterMs,
      });
      let released = false;
      try { released = options.onStale?.({ viewerId: viewer.viewerId, reason: 'active-no-fresh-frame', snapshot: snapshot(viewer) }) === true; }
      catch { released = false; }
      if (released) {
        viewer.released = true;
        event(viewer, 'slot_released', { reason: 'active-media-stale', release: 'applied' });
      } else {
        event(viewer, 'slot_release_failed', { reason: 'active-media-stale', release: 'not-applied' });
      }
    }
    // A page-hidden session is eligible for cleanup only after the bounded
    // grace period and when its control heartbeat is no longer alive. This
    // preserves a live hidden tab that is still renewing its authority.
    if (hiddenSuspended && !viewer.staleEmitted
      && (progressAge === null || progressAge >= staleAfterMs)) {
      viewer.staleEmitted = true;
      event(viewer, 'session_stale_detected', {
        reason: 'page-hidden',
        lastFrameAgeMs: frameAge,
        lastProgressAgeMs: progressAge,
        lastHeartbeatAgeMs: heartbeatAge,
      });
      let released = false;
      try { released = options.onStale?.({ viewerId: viewer.viewerId, reason: 'page-hidden', snapshot: snapshot(viewer) }) === true; }
      catch { released = false; }
      if (released) {
        viewer.released = true;
        event(viewer, 'slot_released', { reason: 'media-stale', release: 'applied' });
      } else {
        event(viewer, 'slot_release_failed', { reason: 'media-stale', release: 'not-applied' });
      }
    }
    publish(viewer);
  }

  function tick() {
    if (stopped) return;
    const at = readNow();
    if (at === null) return;
    viewers.forEach(viewer => evaluate(viewer, at));
  }

  function register(viewerId) {
    const viewer = ensure(viewerId);
    if (viewer) publish(viewer);
    return viewer ? snapshot(viewer) : null;
  }

  function unregister(viewerId) {
    viewers.delete(viewerId);
    try { options.onSnapshot?.(viewerId, null); } catch { /* best effort */ }
  }

  function rebind(previousViewerId, viewerId) {
    if (previousViewerId === viewerId) return register(viewerId);
    const viewer = viewers.get(previousViewerId);
    if (!viewer) return register(viewerId);
    viewers.delete(previousViewerId);
    viewer.viewerId = viewerId;
    viewers.set(viewerId, viewer);
    publish(viewer);
    return snapshot(viewer);
  }

  function observeMedia(viewerId, data = {}) {
    const viewer = ensure(viewerId);
    if (!viewer) return null;
    const at = readNow();
    if (at !== null) viewer.lastMediaAt = at;
    if (data.state === 'suspended') {
      viewer.mediaState = 'suspended';
      viewer.pageVisibility = Array.isArray(data.reasons)
        && data.reasons.some(reason => reason === 'page-hidden' || reason === 'page-hide')
        ? 'hidden' : viewer.pageVisibility;
      if (viewer.pageVisibility === 'hidden' && viewer.suspendedSince === null) viewer.suspendedSince = at;
    } else if (data.state === 'active') {
      viewer.mediaState = 'active';
      viewer.pageVisibility = 'visible';
      viewer.suspendedSince = null;
      viewer.mediaStalledEmitted = false;
      viewer.staleEmitted = false;
      viewer.activeStallSince = null;
      viewer.activeRecoveryEmitted = false;
    }
    if (typeof data.applied === 'boolean' && at !== null) viewer.lastMediaAckAt = at;
    if (Number.isSafeInteger(data.generation) && data.generation >= 1) viewer.generation = data.generation;
    publish(viewer);
    return snapshot(viewer);
  }

  function observeStats(viewerId, data = {}) {
    const viewer = ensure(viewerId);
    if (!viewer) return null;
    const at = readNow();
    if (at === null) return snapshot(viewer);
    viewer.lastStatsAt = at;
    const received = boundedNonnegative(data.receivedDelta ?? data.framesReceived ?? 0, 0);
    const decoded = boundedNonnegative(data.decodedDelta ?? data.framesDecoded ?? 0, 0);
    if (received > 0) viewer.lastReceivedAt = at;
    if (decoded > 0) {
      viewer.lastDecodedAt = at;
      viewer.mediaState = 'active';
      viewer.mediaStalledEmitted = false;
      viewer.activeStallSince = null;
      viewer.activeRecoveryEmitted = false;
    }
    evaluate(viewer, at);
    return snapshot(viewer);
  }

  function observeHeartbeat(viewerId) {
    const viewer = ensure(viewerId);
    if (!viewer) return null;
    const at = readNow();
    if (at !== null) viewer.lastHeartbeatAt = at;
    publish(viewer);
    return snapshot(viewer);
  }

  function get(viewerId) {
    const viewer = viewers.get(viewerId);
    return viewer ? snapshot(viewer) : null;
  }

  function snapshots() {
    return Object.fromEntries([...viewers].map(([viewerId, viewer]) => [viewerId, snapshot(viewer)]));
  }

  function start() {
    if (timer !== null || stopped) return;
    timer = setIntervalFn(tick, tickMs);
    timer?.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
  }

  start();
  return {
    register, unregister, rebind, observeMedia, observeStats, observeHeartbeat,
    get, snapshots, tick, start, stop, staleAfterMs, activeRecoveryAfterMs,
  };
}

module.exports = {
  DEFAULT_STALE_AFTER_MS,
  MIN_STALE_AFTER_MS,
  MAX_STALE_AFTER_MS,
  DEFAULT_ACTIVE_RECOVERY_AFTER_MS,
  MAX_ACTIVE_RECOVERY_AFTER_MS,
  createViewerFreshnessRegistry,
};
