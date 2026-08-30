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
    const clock = typeof c.clock === 'function' ? c.clock : Date.now;
    const setTimer = typeof c.setTimer === 'function' ? c.setTimer : (fn, ms) => setTimeout(fn, ms);
    const clearTimer = typeof c.clearTimer === 'function' ? c.clearTimer : (id) => clearTimeout(id);
    let frameScheduler = null;
    const requestFrame = (fn) => typeof frameScheduler === 'function' ? frameScheduler(fn) : setTimer(fn, 16);
    let state = STATES.IDLE, bound = false, primaryId = null, activeButton = null, pressTimer = null, lastPoint = null, centroid = null, wheelFrame = null, pendingWheel = null, pendingMove = null, moveFrame = null, resetSent = false;
    const pointers = new Map(), handlers = {};
    const enabled = () => Boolean(isEnabled());
    const mapped = (event, outside = true) => { const p = mapPoint(event, outside); return p && Number.isFinite(Number(p.relX)) && Number.isFinite(Number(p.relY)) ? { relX: Number(p.relX), relY: Number(p.relY) } : null; };
    const remember = (point) => { if (point) lastPoint = { relX: point.relX, relY: point.relY }; };
    const clearPress = () => { if (pressTimer !== null) clearTimer(pressTimer); pressTimer = null; };
    const emitReset = (reason) => { if (resetSent) return null; resetSent = true; const id = sendMouse('reset', { reason: String(reason || 'reset').slice(0, 64) }); if (id) resetSent = false; return id; };
    const emit = (action, payload, reason) => { const id = sendMouse(action, payload); if ((action === 'down' || action === 'up') && !id) emitReset(reason || `${action}-failed`); return id; };
    const releaseCapture = (id) => { if (element?.hasPointerCapture?.(id)) element.releasePointerCapture(id); };
    const currentCentroid = () => {
      const active = [...pointers.values()].slice(0, 2);
      if (!active.length) return null;
      const clientX = active.reduce((total, pointer) => total + pointer.clientX, 0) / active.length;
      const clientY = active.reduce((total, pointer) => total + pointer.clientY, 0) / active.length;
      const point = mapped({ clientX, clientY }, true);
      return point ? { clientX, clientY, point } : null;
    };
    const reset = (reason = 'reset') => { if (state === STATES.RESETTING) return null; state = STATES.RESETTING; clearPress(); pendingWheel = null; wheelFrame = null; pendingMove = null; moveFrame = null; pointers.forEach((_, id) => releaseCapture(id)); pointers.clear(); primaryId = null; centroid = null; const shouldReset = Boolean(activeButton); activeButton = null; const id = shouldReset ? emitReset(reason) : null; state = STATES.IDLE; return id; };
    const flushMove = () => { moveFrame = null; const move = pendingMove; pendingMove = null; if (move && enabled()) sendMouse('move', move); };
    const queueMove = (point, buttons) => { pendingMove = { ...point, buttons }; if (moveFrame !== null) return; moveFrame = requestFrame(flushMove); };
    const queueWheel = (dx, dy, point) => { if (!pendingWheel) pendingWheel = { relX: point.relX, relY: point.relY, deltaX: 0, deltaY: 0 }; pendingWheel.relX = point.relX; pendingWheel.relY = point.relY; pendingWheel.deltaX += Number(dx) || 0; pendingWheel.deltaY += Number(dy) || 0; if (wheelFrame !== null) return; wheelFrame = requestFrame(() => { wheelFrame = null; const wheel = pendingWheel; pendingWheel = null; if (wheel && enabled() && (wheel.deltaX || wheel.deltaY)) sendMouse('wheel', wheel); }); };
    function pointerdown(event) {
      if (event.pointerType !== 'touch' || !enabled() || resetSent || (event.isPrimary === false && pointers.size === 0)) return;
      event.preventDefault?.(); const point = mapped(event, false); if (!point || pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { point, startedAt: clock(), clientX: Number(event.clientX) || 0, clientY: Number(event.clientY) || 0 }); remember(point); element?.setPointerCapture?.(event.pointerId);
      if (pointers.size > 1) { clearPress(); if (activeButton) { emitReset('two-finger-scroll'); activeButton = null; } state = STATES.SCROLLING; centroid = currentCentroid(); return; }
      primaryId = event.pointerId; state = STATES.PRESSED;
      pressTimer = setTimer(() => { pressTimer = null; if (state !== STATES.PRESSED || primaryId !== event.pointerId) return; const p = pointers.get(event.pointerId)?.point; const id = p && emit('down', { ...p, button: 'right', clickCount: 1, buttons: 2 }, 'long-press-down-failed'); if (id) activeButton = 'right'; }, LONG_PRESS_MS);
    }
    function pointermove(event) {
      if (event.pointerType !== 'touch' || resetSent) return; const p = pointers.get(event.pointerId); if (!p) return; const point = mapped(event, true); if (!point) return;
      const dx = (Number(event.clientX) || 0) - p.clientX, dy = (Number(event.clientY) || 0) - p.clientY;
      p.point = point; remember(point);
      p.clientX = Number(event.clientX) || 0; p.clientY = Number(event.clientY) || 0;
      if (state === STATES.SCROLLING) { const next = currentCentroid(); if (centroid && next) queueWheel(next.clientX - centroid.clientX, next.clientY - centroid.clientY, next.point); centroid = next; return; }
      if (event.pointerId !== primaryId) return;
      if (state === STATES.DRAGGING) { queueMove(point, activeButton === 'right' ? 2 : 1); return; }
      if (state !== STATES.PRESSED) return;
      if (activeButton === 'right') { state = STATES.DRAGGING; queueMove(point, 2); return; }
      if (Math.hypot(dx, dy) <= MOVE_THRESHOLD) return;
      clearPress(); const id = emit('down', { ...point, button: 'left', clickCount: 1, buttons: 1 }, 'drag-down-failed'); if (!id) return; activeButton = 'left'; state = STATES.DRAGGING; queueMove(point, 1);
    }
    function pointerup(event) {
      if (event.pointerType !== 'touch') return; const p = pointers.get(event.pointerId); if (!p) return; event.preventDefault?.(); const point = mapped(event, true) || p.point || lastPoint; remember(point); pointers.delete(event.pointerId); releaseCapture(event.pointerId);
      if (state === STATES.SCROLLING) { if (!pointers.size) { state = STATES.IDLE; primaryId = null; centroid = null; } else centroid = currentCentroid(); return; }
      if (event.pointerId !== primaryId) return; clearPress();
      if (resetSent) { activeButton = null; primaryId = null; state = STATES.IDLE; return; }
      const button = activeButton;
      if (button) { if (state === STATES.DRAGGING) flushMove(); if (point) emit('up', { ...point, button, clickCount: 1, buttons: 0 }, 'pointer-up-failed'); }
      else if (state === STATES.PRESSED && point && enabled()) { const clickCount = Number(getClickCount({ button: 0, timeStamp: event.timeStamp, clientX: event.clientX, clientY: event.clientY })) || 1; const down = { ...point, button: 'left', clickCount, buttons: 1 }; const id = emit('down', down, 'tap-down-failed'); if (id) emit('up', { ...point, button: 'left', clickCount, buttons: 0 }, 'tap-up-failed'); }
      activeButton = null; primaryId = null; state = STATES.IDLE;
    }
    function bind() { if (bound || !element?.addEventListener) return; frameScheduler = typeof root?.requestAnimationFrame === 'function' ? root.requestAnimationFrame.bind(root) : null; bound = true; Object.assign(handlers, { pointerdown, pointermove, pointerup, pointercancel: () => reset('pointer-cancel'), lostpointercapture: () => reset('lost-pointer-capture') }); Object.entries(handlers).forEach(([t, h]) => element.addEventListener(t, h)); }
    function unbind() { if (!bound) return; Object.entries(handlers).forEach(([t, h]) => element.removeEventListener?.(t, h)); bound = false; reset('unbind'); }
    function clickButton(button, coords) { if (!enabled()) return null; const p = coords && Number.isFinite(Number(coords.relX)) ? { relX: Number(coords.relX), relY: Number(coords.relY) } : lastPoint; if (!p) return null; const b = button === 'right' || button === 2 ? 'right' : button === 'middle' || button === 1 ? 'middle' : 'left'; const id = emit('down', { ...p, button: b, clickCount: 1, buttons: b === 'right' ? 2 : 1 }, 'button-down-failed'); if (!id) return null; activeButton = b; const up = emit('up', { ...p, button: b, clickCount: 1, buttons: 0 }, 'button-up-failed'); activeButton = null; return up || id; }
    function getSnapshot() { return { state, bound, pointerCount: pointers.size, primaryActive: primaryId !== null, activeButton, pendingReset: resetSent, wheelPending: Boolean(pendingWheel) }; }
    return { bind, unbind, reset, clickButton, getSnapshot };
  }
  return { STATES, create };
}));
