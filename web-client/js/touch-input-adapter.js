(function attachTouchInputAdapter(root, factory) {
  const api = factory(root);
  api.TouchInputAdapter = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TouchInputAdapter = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createTouchInputAdapterApi(root) {
  const STATES = Object.freeze({ IDLE: 'IDLE', PRESSED: 'PRESSED', DRAGGING: 'DRAGGING', SCROLLING: 'SCROLLING', RESETTING: 'RESETTING' });
  const MOVE_THRESHOLD = 8;
  const LONG_PRESS_MS = 550;
  function create(options) {
    const c = options || {}, element = c.element;
    const mapPoint = typeof c.mapPoint === 'function' ? c.mapPoint : () => null;
    const sendMouse = typeof c.sendMouse === 'function' ? c.sendMouse : () => null;
    const isEnabled = typeof c.isEnabled === 'function' ? c.isEnabled : () => true;
    const getClickCount = typeof c.getClickCount === 'function' ? c.getClickCount : () => 1;
    const beforeGesture = typeof c.beforeGesture === 'function' ? c.beforeGesture : () => true;
    const commitGesture = typeof c.commitGesture === 'function' ? c.commitGesture : (send) => send();
    const validateGeometry = typeof c.validateGeometry === 'function' ? c.validateGeometry : () => true;
    const clock = typeof c.clock === 'function' ? c.clock : Date.now;
    const setTimer = typeof c.setTimer === 'function' ? c.setTimer : (fn, ms) => setTimeout(fn, ms);
    const clearTimer = typeof c.clearTimer === 'function' ? c.clearTimer : (id) => clearTimeout(id);
    const onTraceDomEvent = typeof c.onTraceDomEvent === 'function' ? c.onTraceDomEvent : () => null;
    const onTraceEventEnd = typeof c.onTraceEventEnd === 'function' ? c.onTraceEventEnd : () => {};
    const withTraceEvent = typeof c.withTraceEvent === 'function'
      ? c.withTraceEvent : (_eventId, send) => send();
    let frameScheduler = null;
    const requestFrame = (fn) => typeof frameScheduler === 'function' ? frameScheduler(fn) : setTimer(fn, 16);
    let state = STATES.IDLE, bound = false, primaryId = null, activeButton = null, pressTimer = null, lastPoint = null, centroid = null, wheelFrame = null, pendingWheel = null, pendingMove = null, moveFrame = null, resetSent = false, generation = 0;
    const pointers = new Map(), handlers = {};
    const enabled = () => Boolean(isEnabled());
    const mapped = (event, outside = true) => { const p = mapPoint(event, outside); return p && Number.isFinite(Number(p.relX)) && Number.isFinite(Number(p.relY)) ? { relX: Number(p.relX), relY: Number(p.relY) } : null; };
    const remember = (point) => { if (point) lastPoint = { relX: point.relX, relY: point.relY }; };
    const clearPress = () => { if (pressTimer !== null) clearTimer(pressTimer); pressTimer = null; };
    const traceDom = (_event, action, phase, incidentEligible) => {
      try {
        const eventId = onTraceDomEvent({
          inputType: 'pointer', action, phase, focusKind: 'desktop', visibility: 'visible',
          incidentEligible,
        });
        return Number.isSafeInteger(eventId) && eventId > 0 ? eventId : null;
      } catch (_) {
        return null;
      }
    };
    const endTrace = (eventId) => {
      if (!Number.isSafeInteger(eventId)) return;
      try { onTraceEventEnd(eventId); } catch (_) { /* observational */ }
    };
    const traced = (eventId, callback, options = {}) => {
      let invoked = false;
      let result;
      let callbackError = null;
      const invoke = () => {
        if (invoked) return result;
        invoked = true;
        try {
          result = callback();
          return result;
        } catch (error) {
          callbackError = error;
          throw error;
        }
      };
      const traceOptions = {
        ...(eventId === null
          ? { incidentEligible: false }
          : { refreshEligibility: true, focusKind: 'desktop' }),
        ...options,
      };
      try {
        return withTraceEvent(eventId, invoke, traceOptions);
      } catch (error) {
        if (callbackError) throw callbackError;
        if (invoked) return result;
        return invoke();
      }
    };
    const emitReset = (reason) => {
      if (resetSent) return null;
      resetSent = true;
      const id = traced(null, () => sendMouse('reset', { reason: String(reason || 'reset').slice(0, 64) }));
      if (id) resetSent = false;
      return id;
    };
    const emit = (action, payload, reason, eventId = null, options = {}) => {
      const id = traced(eventId, () => sendMouse(action, payload), options);
      if ((action === 'down' || action === 'up') && !id) emitReset(reason || `${action}-failed`);
      return id;
    };
    const releaseCapture = (id) => { if (element?.hasPointerCapture?.(id)) element.releasePointerCapture(id); };
    const clearGesture = () => {
      clearPress(); pendingWheel = null; wheelFrame = null; pendingMove = null; moveFrame = null;
      pointers.forEach((_, id) => releaseCapture(id)); pointers.clear();
      primaryId = null; centroid = null; activeButton = null; state = STATES.IDLE; generation += 1;
    };
    const geometryCheck = (reason) => {
      const before = generation;
      if (validateGeometry() !== false) return generation === before;
      if (generation === before) clearGesture(reason || 'geometry-changed');
      return false;
    };
    const commitDown = (payload, reason, eventId = null, traceOptions = {}) => {
      let attempted = false; let inputId = null;
      const send = () => {
        attempted = true;
        inputId = sendMouse('down', payload);
        return inputId;
      };
      const accepted = Boolean(traced(eventId, () => commitGesture(send), traceOptions));
      if (!accepted || !attempted || !inputId) {
        clearGesture(reason || 'down-rejected');
        if (attempted && !inputId) emitReset(reason || 'down-failed');
        return null;
      }
      return inputId;
    };
    const currentCentroid = () => {
      const active = [...pointers.values()].slice(0, 2);
      if (!active.length) return null;
      const clientX = active.reduce((total, pointer) => total + pointer.clientX, 0) / active.length;
      const clientY = active.reduce((total, pointer) => total + pointer.clientY, 0) / active.length;
      const point = mapped({ clientX, clientY }, true);
      return point ? { clientX, clientY, point } : null;
    };
    const reset = (reason = 'reset') => {
      if (state === STATES.RESETTING) return null;
      const shouldReset = Boolean(activeButton);
      state = STATES.RESETTING;
      clearGesture();
      const id = shouldReset ? emitReset(reason) : null;
      state = STATES.IDLE;
      return id;
    };
    const flushMove = () => {
      moveFrame = null;
      const frameGeneration = generation;
      if (!geometryCheck('geometry-before-move')) return;
      if (generation !== frameGeneration) return;
      const move = pendingMove; pendingMove = null;
      if (move && enabled() && generation === frameGeneration) traced(null, () => sendMouse('move', move));
    };
    const queueMove = (point, buttons) => { pendingMove = { ...point, buttons }; if (moveFrame !== null) return; moveFrame = requestFrame(flushMove); };
    const flushWheel = () => {
      wheelFrame = null;
      const frameGeneration = generation;
      if (!geometryCheck('geometry-before-wheel')) return;
      if (generation !== frameGeneration) return;
      const wheel = pendingWheel;
      if (!wheel || !enabled() || (!wheel.deltaX && !wheel.deltaY)) return;
      pendingWheel = null;
      if (generation === frameGeneration) traced(null, () => sendMouse('wheel', wheel));
    };
    const queueWheel = (dx, dy, point) => { if (!pendingWheel) pendingWheel = { relX: point.relX, relY: point.relY, deltaX: 0, deltaY: 0 }; pendingWheel.relX = point.relX; pendingWheel.relY = point.relY; pendingWheel.deltaX += Number(dx) || 0; pendingWheel.deltaY += Number(dy) || 0; if (wheelFrame !== null) return; wheelFrame = requestFrame(flushWheel); };
    function pointerdown(event) {
      if (event.pointerType !== 'touch') return;
      const traceEventId = traceDom(event, 'down', 'down', true);
      try {
        if (!enabled() || resetSent || (event.isPrimary === false && pointers.size === 0)) {
          event.preventDefault?.();
          return;
        }
        const entryGeneration = generation;
        if (pointers.size === 0 && !beforeGesture()) {
          event.preventDefault?.();
          clearGesture('before-gesture-rejected');
          return;
        }
        if (pointers.size === 0 && generation !== entryGeneration) return;
        event.preventDefault?.();
        const point = mapped(event, false);
        if (!point || generation !== entryGeneration || pointers.has(event.pointerId)) return;
        const clientX = Number(event.clientX) || 0, clientY = Number(event.clientY) || 0;
        pointers.set(event.pointerId, {
          startPoint: { ...point }, point: { ...point }, startedAt: clock(),
          startClientX: clientX, startClientY: clientY, clientX, clientY,
          traceEventId, traceFocusKind: 'desktop',
        });
        remember(point); element?.setPointerCapture?.(event.pointerId);
        if (pointers.size > 1) {
          clearPress(); if (activeButton) { emitReset('two-finger-scroll'); activeButton = null; }
          state = STATES.SCROLLING;
          const next = currentCentroid();
          if (generation !== entryGeneration) return;
          centroid = next;
          return;
        }
        primaryId = event.pointerId; state = STATES.PRESSED;
        const timerGeneration = generation;
        pressTimer = setTimer(() => {
          pressTimer = null;
          if (state !== STATES.PRESSED || primaryId !== event.pointerId || generation !== timerGeneration) return;
          if (!geometryCheck('geometry-before-long-press')) return;
          if (generation !== timerGeneration) return;
          const pointer = pointers.get(event.pointerId);
          const p = pointer?.startPoint;
          const id = p && commitDown(
            { ...p, button: 'right', clickCount: 1, buttons: 2 },
            'long-press-down-failed', pointer?.traceEventId,
            { focusKind: pointer?.traceFocusKind || 'desktop' },
          );
          if (id && generation === timerGeneration) activeButton = 'right';
        }, LONG_PRESS_MS);
      } finally {
        endTrace(traceEventId);
      }
    }
    function pointermove(event) {
      if (event.pointerType !== 'touch' || resetSent) return;
      const entryGeneration = generation;
      const p = pointers.get(event.pointerId); if (!p) return;
      if (!geometryCheck('geometry-before-move')) return;
      if (generation !== entryGeneration) return;
      const point = mapped(event, true);
      if (!point || generation !== entryGeneration) return;
      const dx = (Number(event.clientX) || 0) - p.startClientX, dy = (Number(event.clientY) || 0) - p.startClientY;
      p.point = { ...point }; remember(point);
      p.clientX = Number(event.clientX) || 0; p.clientY = Number(event.clientY) || 0;
      if (state === STATES.SCROLLING) { const next = currentCentroid(); if (generation !== entryGeneration) return; if (centroid && next) queueWheel(next.clientX - centroid.clientX, next.clientY - centroid.clientY, next.point); centroid = next; return; }
      if (event.pointerId !== primaryId) return;
      if (state === STATES.DRAGGING) { queueMove(point, activeButton === 'right' ? 2 : 1); return; }
      if (state !== STATES.PRESSED) return;
      if (activeButton === 'right') { state = STATES.DRAGGING; queueMove(point, 2); return; }
      if (Math.hypot(dx, dy) <= MOVE_THRESHOLD) return;
      clearPress(); const downGeneration = generation;
      const id = commitDown(
        { ...p.startPoint, button: 'left', clickCount: 1, buttons: 1 },
        'drag-down-failed', p.traceEventId,
        { focusKind: p.traceFocusKind || 'desktop' },
      );
      if (!id || generation !== downGeneration) return;
      activeButton = 'left'; state = STATES.DRAGGING; queueMove(point, 1);
    }
    function pointerup(event) {
      if (event.pointerType !== 'touch') return;
      const traceEventId = traceDom(event, 'up', 'up');
      try {
        const entryGeneration = generation;
        const p = pointers.get(event.pointerId); if (!p) return;
        if (!geometryCheck('geometry-before-up')) return;
        if (generation !== entryGeneration) return;
        event.preventDefault?.(); const point = mapped(event, true) || p.point || lastPoint;
        if (generation !== entryGeneration) return;
        remember(point); pointers.delete(event.pointerId); releaseCapture(event.pointerId);
        if (state === STATES.SCROLLING) {
          if (!pointers.size) { state = STATES.IDLE; primaryId = null; centroid = null; }
          else {
            const next = currentCentroid();
            if (generation !== entryGeneration) return;
            centroid = next;
          }
          return;
        }
        if (event.pointerId !== primaryId) return; clearPress();
        if (resetSent) { activeButton = null; primaryId = null; state = STATES.IDLE; return; }
        const button = activeButton;
        if (button) {
          if (state === STATES.DRAGGING) flushMove();
          if (generation !== entryGeneration) return;
          if (point) emit(
            'up', { ...point, button, clickCount: 1, buttons: 0 }, 'pointer-up-failed', traceEventId,
            { refreshEligibility: true, allowSurfacePending: true },
          );
        } else if (state === STATES.PRESSED && point && enabled()) {
          const clickCount = Number(getClickCount({ button: 0, timeStamp: event.timeStamp, clientX: event.clientX, clientY: event.clientY })) || 1;
          const down = { ...p.startPoint, button: 'left', clickCount, buttons: 1 };
          const tapGeneration = generation;
          const id = commitDown(down, 'tap-down-failed', p.traceEventId, {
            focusKind: p.traceFocusKind || 'desktop',
          });
          if (generation !== tapGeneration) return;
          if (id) emit(
            'up', { ...point, button: 'left', clickCount, buttons: 0 }, 'tap-up-failed', traceEventId,
            { refreshEligibility: true, allowSurfacePending: true },
          );
        }
        activeButton = null; primaryId = null; state = STATES.IDLE;
      } finally {
        endTrace(traceEventId);
      }
    }
    function bind() { if (bound || !element?.addEventListener) return; frameScheduler = typeof root?.requestAnimationFrame === 'function' ? root.requestAnimationFrame.bind(root) : null; bound = true; Object.assign(handlers, { pointerdown, pointermove, pointerup, pointercancel: () => reset('pointer-cancel'), lostpointercapture: (event) => { if (event?.pointerType !== 'touch' || !pointers.has(event.pointerId)) return; reset('lost-pointer-capture'); } }); Object.entries(handlers).forEach(([t, h]) => element.addEventListener(t, h)); }
    function unbind() { if (!bound) return; Object.entries(handlers).forEach(([t, h]) => element.removeEventListener?.(t, h)); bound = false; reset('unbind'); }
    // Input owns the authoritative mouse reset barrier. A failed reset send can
    // leave this private latch set even after Input receives a fresh lease, so
    // expose the one state transition needed to re-arm touch delivery.
    function rearm() { resetSent = false; return true; }
    function clickButton(button, coords) {
      if (!enabled()) return null;
      const p = coords && Number.isFinite(Number(coords.relX))
        ? { relX: Number(coords.relX), relY: Number(coords.relY) }
        : lastPoint;
      if (!p) return null;
      const b = button === 'right' || button === 2 ? 'right' : button === 'middle' || button === 1 ? 'middle' : 'left';
      let inputId = null;
      const accepted = Boolean(traced(null, () => commitGesture(() => {
        inputId = emit('down', { ...p, button: b, clickCount: 1, buttons: b === 'right' ? 2 : 1 }, 'button-down-failed');
        return inputId;
      })));
      if (!accepted || !inputId) return null;
      activeButton = b;
      const up = emit('up', { ...p, button: b, clickCount: 1, buttons: 0 }, 'button-up-failed', null);
      activeButton = null;
      return up || inputId;
    }
    function flushPending() { if (pendingWheel && wheelFrame === null) wheelFrame = requestFrame(flushWheel); }
    function getSnapshot() { return { state, bound, pointerCount: pointers.size, primaryActive: primaryId !== null, activeButton, pendingReset: resetSent, wheelPending: Boolean(pendingWheel) }; }
    return { bind, unbind, reset, rearm, clickButton, flushPending, getSnapshot };
  }
  return { STATES, create };
}));
