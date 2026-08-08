'use strict';

/**
 * Pure observer Map operations for terminal session presence.
 * No hooks, audit, metrics, dispatcher, or presenter knowledge.
 */

function trim(value) {
  return String(value || '').trim();
}

function snapshotObserver(key, observer) {
  if (observer && typeof observer === 'object') {
    return {
      ...observer,
      observerId: trim(observer.observerId) || key,
    };
  }
  return { observerId: key };
}

function hasObserver(observers, selector = {}) {
  if (!observers || typeof observers.values !== 'function') {
    return false;
  }
  const observerId = trim(selector.observerId);
  const socketId = trim(selector.socketId);
  const clientId = trim(selector.clientId);

  if (observerId) {
    return typeof observers.has === 'function' ? observers.has(observerId) : false;
  }
  if (socketId) {
    for (const observer of observers.values()) {
      if (observer && observer.socketId === socketId) return true;
    }
    return false;
  }
  if (clientId) {
    for (const observer of observers.values()) {
      if (observer && observer.clientId === clientId) return true;
    }
    return false;
  }
  return false;
}

/**
 * Remove observers by selector.
 * Precedence: exact observerId (one only, never expands) → socketId (all matches) → clientId (all matches).
 * @returns {{ removed: object[], removedCount: number }}
 */
function removeObservers(observers, selector = {}) {
  const removed = [];
  if (!observers || typeof observers.delete !== 'function' || typeof observers.entries !== 'function') {
    return { removed, removedCount: 0 };
  }

  const observerId = trim(selector.observerId);
  const socketId = trim(selector.socketId);
  const clientId = trim(selector.clientId);

  if (observerId) {
    // Exact only — never fall through to socketId/clientId.
    if (typeof observers.has === 'function' && observers.has(observerId)) {
      const observer = observers.get(observerId);
      observers.delete(observerId);
      removed.push(snapshotObserver(observerId, observer));
    }
    return { removed, removedCount: removed.length };
  }

  if (socketId) {
    const toDelete = [];
    for (const [key, observer] of observers.entries()) {
      if (observer && observer.socketId === socketId) {
        toDelete.push([key, observer]);
      }
    }
    for (const [key, observer] of toDelete) {
      observers.delete(key);
      removed.push(snapshotObserver(key, observer));
    }
    return { removed, removedCount: removed.length };
  }

  if (clientId) {
    const toDelete = [];
    for (const [key, observer] of observers.entries()) {
      if (observer && observer.clientId === clientId) {
        toDelete.push([key, observer]);
      }
    }
    for (const [key, observer] of toDelete) {
      observers.delete(key);
      removed.push(snapshotObserver(key, observer));
    }
    return { removed, removedCount: removed.length };
  }

  return { removed, removedCount: 0 };
}

module.exports = {
  hasObserver,
  removeObservers,
};
