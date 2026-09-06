const OVERFLOW_ACTION_SELECTOR = '.action-btn:not(.action-more):not([data-pin="always"])';
const IDLE_EDGE_PX = 80;

const CAPABILITY_IDS = {
  canConnect: ['startBtn'],
  canSendDesktopInput: ['textInputBtn', 'keyboardModeBtn'],
  canRefresh: ['refreshBtn'],
  canPause: ['pauseBtn'],
  canDisconnect: ['disconnectBtn'],
  canOpenNetwork: ['networkModeBtn'],
  canOpenResolution: ['resolutionBtn'],
  canOpenTerminal: ['terminalTabBtn'],
};
const MEDIA_CONTROL_IDS = ['scaleBtn', 'fullscreenBtn'];
const MOBILE_LAYOUT_PROPERTIES = [
  '--mobile-visible-top',
  '--mobile-viewer-top',
  '--mobile-viewer-height',
  '--mobile-dock-bottom',
  '--mobile-text-bottom',
];
const MOBILE_LAYOUT_CLASS = 'mobile-layout-managed';
const MOBILE_LAYOUT_COMPACT_CLASS = 'mobile-layout-compact';
const MOBILE_LAYOUT_ULTRA_CLASS = 'mobile-layout-ultra';
const MOBILE_LAYOUT_UNSUPPORTED_CLASS = 'mobile-layout-unsupported';

const ChromeLayout = {
  IDLE_MS: 2500,
  autoIdleEnabled: true,
  _lastActivity: 0,
  _idleTimer: null,
  _wasStreamConnected: false,
  _wasControlsHidden: false,
  _mobileViewportCleanup: null,
  _mobileDockCleanup: null,
  _mobileViewportSnapshot: null,
  _mobileLayoutCleanup: null,
  _mobileLayoutRaf: null,
  _mobileLayoutPending: null,
  _mobileLayoutResult: null,
  _mobileLayoutLastSupported: null,
  init() {
    const statusEl = typeof document !== 'undefined' ? document.getElementById('statusBar') : null;
    const unobserve = this.observeStatusBar(statusEl);
    const unobserveViewport = this.observeMobileViewport();
    const unobserveDocks = this.observeMobileDocks();
    const unobserveLayout = this.observeMobileLayout();
    const unbindMore = this.bindMoreMenu();
    const unbindIdle = this.bindIdle();
    this.syncToggleControlsLabel();
    return () => {
      unobserve();
      unobserveViewport();
      unobserveDocks();
      unobserveLayout();
      unbindMore();
      unbindIdle();
    };
  },
  docksAreAway(body) {
    return !!body?.classList?.contains?.('controls-hidden')
      || !!body?.classList?.contains?.('chrome-idle');
  },
  isFullscreenActive(rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    const body = root?.body || root?.querySelector?.('body');
    return !!body?.classList?.contains?.('fullscreen-active');
  },
  syncToggleControlsLabel(rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    const body = root?.body || root?.querySelector?.('body');
    const btn = root?.getElementById?.('toggleControlsBtn') || root?.querySelector?.('#toggleControlsBtn');
    if (!btn) return;
    btn.textContent = this.docksAreAway(body) ? '显示控件' : '隐藏控件';
  },
  revealViewerChrome(rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    const body = root?.body || root?.querySelector?.('body');
    body?.classList?.remove?.('controls-hidden');
    body?.classList?.remove?.('chrome-idle');
    this.bump(root);
    this.syncToggleControlsLabel(root);
  },
  onToggleControlsClick(rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    const body = root?.body || root?.querySelector?.('body');
    if (!body?.classList) return;
    if (this.docksAreAway(body)) this.revealViewerChrome(root);
    else body.classList.add('controls-hidden');
    this.syncToggleControlsLabel(root);
  },
  shouldIdle({ streamConnected, controlsHidden, menuOpen, modalOpen, mobileInputMode, idleMs } = {}) {
    return !!streamConnected
      && !controlsHidden
      && !menuOpen
      && !modalOpen
      && !['visible', 'composing', 'pending', 'blocked'].includes(mobileInputMode)
      && Number(idleMs) >= this.IDLE_MS;
  },
  collectIdleInputs(rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    const body = root?.body || root?.querySelector?.('body');
    const moreBtn = root?.getElementById?.('moreActionsBtn') || root?.querySelector?.('#moreActionsBtn');
    const menuOpen = !!body?.classList?.contains?.('more-open')
      || moreBtn?.getAttribute?.('aria-expanded') === 'true';
    const mobileInputSnapshot = typeof Input !== 'undefined'
      ? Input.mobileTextInputAdapter?.getSnapshot?.() : null;
    const status = String(mobileInputSnapshot?.status || '').toLowerCase();
    const mobileInputMode = status === 'blocked' || status === 'uncertain' || mobileInputSnapshot?.deliveryUncertain === true
      ? 'blocked'
      : status === 'composing' || mobileInputSnapshot?.composing === true ? 'composing'
        : status === 'pending' || mobileInputSnapshot?.hasPending === true ? 'pending'
          : ['visible', 'composing', 'pending', 'blocked'].includes(mobileInputSnapshot?.mobileInputMode)
            ? mobileInputSnapshot.mobileInputMode
            : mobileInputSnapshot?.shown ? 'visible' : 'off';
    return {
      streamConnected: !!body?.classList?.contains?.('stream-connected'),
      controlsHidden: !!body?.classList?.contains?.('controls-hidden'),
      menuOpen,
      modalOpen: !!root?.querySelector?.('.modal:not(.hidden)'),
      mobileInputMode,
      idleMs: Date.now() - (this._lastActivity || 0),
    };
  },
  enterIdle(rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    if (this.isFullscreenActive(root)) return;
    if (!this.autoIdleEnabled) return;
    const body = root?.body || root?.querySelector?.('body');
    body?.classList?.add?.('chrome-idle');
    this.syncToggleControlsLabel(root);
    const advisor = root?.getElementById?.('networkAdvisor') || root?.querySelector?.('#networkAdvisor');
    if (advisor?.classList?.contains?.('visible')) advisor.classList.add('collapsed');
  },
  bump(rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    if (this.isFullscreenActive(root)) return;
    const body = root?.body || root?.querySelector?.('body');
    const wasIdle = !!body?.classList?.contains?.('chrome-idle');
    if (wasIdle) {
      body.classList.remove('chrome-idle');
      this.syncToggleControlsLabel(root);
    }
    this._lastActivity = Date.now();
    this.armIdleTimer(root);
  },
  clearIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  },
  armIdleTimer(rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    if (this.isFullscreenActive(root)) return;
    this.clearIdleTimer();
    this._idleTimer = setTimeout(() => {
      if (this.isFullscreenActive(root)) return;
      this._idleTimer = null;
      const inputs = this.collectIdleInputs(root);
      if (this.shouldIdle(inputs)) this.enterIdle(root);
      else if (inputs.streamConnected && !inputs.controlsHidden) this.armIdleTimer(root);
    }, this.IDLE_MS);
  },
  bindIdle(rootEl) {
    if (!this.autoIdleEnabled) return () => {};
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    if (!root?.addEventListener) return () => {};
    const body = root.body || root.querySelector?.('body');
    const docks = root.getElementById?.('chromeDocks') || root.querySelector?.('#chromeDocks');
    const view = root.defaultView || (typeof globalThis !== 'undefined' ? globalThis : null);
    this._lastActivity = Date.now();
    this._wasStreamConnected = !!body?.classList?.contains?.('stream-connected');
    this._wasControlsHidden = !!body?.classList?.contains?.('controls-hidden');

    const isBottomEdge = (event) => {
      const height = view?.innerHeight;
      return Number.isFinite(event?.clientY)
        && Number.isFinite(height)
        && event.clientY > height - IDLE_EDGE_PX;
    };
    const overDocks = (event) => docks && typeof docks.contains === 'function' && docks.contains(event.target);
    const onPointerMove = (event) => {
      if (event.pointerType === 'touch') return;
      if (overDocks(event) || isBottomEdge(event)) this.bump(root);
    };
    const onPointerDown = (event) => {
      if (event.pointerType !== 'touch') return;
      if (isBottomEdge(event)) this.bump(root);
    };
    const onDocksEnter = () => this.bump(root);

    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerdown', onPointerDown);
    const dockTargets = [docks];
    docks?.querySelectorAll?.('.action-bar, .control-bar')?.forEach?.((el) => dockTargets.push(el));
    dockTargets.filter(Boolean).forEach((el) => el.addEventListener?.('pointerenter', onDocksEnter));

    const onMutate = () => {
      if (this.isFullscreenActive(root)) return;
      const inputs = this.collectIdleInputs(root);
      const connectedBecame = inputs.streamConnected && !this._wasStreamConnected;
      const unhid = this._wasControlsHidden && !inputs.controlsHidden;
      this._wasStreamConnected = inputs.streamConnected;
      this._wasControlsHidden = inputs.controlsHidden;
      if (body?.classList?.contains?.('chrome-idle')
          && (!inputs.streamConnected || inputs.controlsHidden || inputs.menuOpen || inputs.modalOpen
            || ['visible', 'composing', 'pending', 'blocked'].includes(inputs.mobileInputMode))) {
        body.classList.remove('chrome-idle');
      }
      this.syncToggleControlsLabel(root);
      if (connectedBecame || (inputs.streamConnected && unhid)) {
        this.bump(root);
        return;
      }
      if (inputs.streamConnected && !inputs.controlsHidden) this.armIdleTimer(root);
      else this.clearIdleTimer();
    };
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(onMutate) : null;
    if (mo && body) mo.observe(body, { attributes: true, attributeFilter: ['class'] });
    if (mo) {
      root.querySelectorAll?.('.modal')?.forEach?.((modal) => {
        mo.observe(modal, { attributes: true, attributeFilter: ['class'] });
      });
    }
    if (this._wasStreamConnected && !this._wasControlsHidden) this.armIdleTimer(root);

    return () => {
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerdown', onPointerDown);
      dockTargets.filter(Boolean).forEach((el) => el.removeEventListener?.('pointerenter', onDocksEnter));
      mo?.disconnect();
      this.clearIdleTimer();
    };
  },
  setFullscreenActive(active, rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    this.clearIdleTimer();
    this.recalculate(root, { schedule: true });
    if (active || this.isFullscreenActive(root)) return;
    const inputs = this.collectIdleInputs(root);
    if (inputs.streamConnected && !inputs.controlsHidden) {
      this._lastActivity = Date.now();
      this.armIdleTimer(root);
    }
  },
  syncChromeTop(px, rootEl) {
    const height = Number(px);
    if (!Number.isFinite(height) || height < 0) return;
    const root = rootEl || (typeof document !== 'undefined' ? document.documentElement : null);
    const value = `${Math.round(height)}px`;
    this._writeStyleValue(root, '--chrome-top', value);
  },
  effectiveChromeTop(measured, rootEl) {
    if (this.isFullscreenActive(rootEl)) return 0;
    const value = Number(measured);
    return Number.isFinite(value) && value > 0 ? value : 56;
  },
  _readStyleValue(style, name) {
    if (!style) return '';
    const computed = typeof style.getPropertyValue === 'function' ? style.getPropertyValue(name) : '';
    return computed || style[name] || '';
  },
  _writeStyleValue(target, name, value) {
    const style = target?.style || target;
    if (!style) return false;
    if (this._readStyleValue(style, name) === value) return false;
    if (typeof style.setProperty === 'function') style.setProperty(name, value);
    else style[name] = value;
    return true;
  },
  _removeStyleValue(target, name) {
    const style = target?.style || target;
    if (!style) return false;
    const current = this._readStyleValue(style, name);
    if (!current) return false;
    if (typeof style.removeProperty === 'function') style.removeProperty(name);
    else delete style[name];
    return true;
  },
  computeMobileLayout(input = {}) {
    const finiteNonNegative = (value, fallback = 0) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? Math.max(0, numeric) : Math.max(0, Number(fallback) || 0);
    };
    const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
    const layoutHeight = finiteNonNegative(input.layoutHeight);
    const visualHeight = finiteNonNegative(input.visualHeight, layoutHeight);
    const offsetTop = finiteNonNegative(input.offsetTop);
    const keyboardRectHeight = finiteNonNegative(input.keyboardRectHeight);
    const safeBottom = finiteNonNegative(input.safeBottom);
    const chromeTop = finiteNonNegative(input.chromeTop);
    const dockContentHeight = finiteNonNegative(input.dockContentHeight);
    const textDockHeight = finiteNonNegative(input.textDockHeight);
    const keyboardOverlay = input.keyboardOverlay === true;
    const visibleTop = keyboardOverlay ? 0 : clamp(offsetTop, 0, layoutHeight);
    const visibleBottom = keyboardOverlay
      ? layoutHeight - clamp(keyboardRectHeight, 0, layoutHeight)
      : clamp(visualHeight + visibleTop, visibleTop, layoutHeight);
    const availableHeight = Math.max(0, visibleBottom - visibleTop);
    const bottomInset = Math.max(0, layoutHeight - visibleBottom);
    const textReserve = input.textVisible === true ? textDockHeight : 0;
    const dockBottom = bottomInset + safeBottom + textReserve + 8;
    const viewerTop = visibleTop + chromeTop;
    const viewerHeight = Math.max(0, availableHeight - chromeTop - safeBottom
      - textReserve - dockContentHeight - 8);
    const compact = input.touchSupported === true && input.textVisible === true;
    const ultraCompact = compact && availableHeight < 360;
    const unsupportedViewport = ultraCompact && availableHeight < 140 + safeBottom;
    return {
      visibleTop,
      visibleBottom,
      availableHeight,
      bottomInset,
      dockBottom,
      viewerTop,
      viewerHeight,
      compact,
      ultraCompact,
      unsupportedViewport,
    };
  },
  _viewportContext(rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    const view = root?.defaultView || root?.ownerDocument?.defaultView
      || (typeof window !== 'undefined' ? window : null);
    const navigatorObject = root?.navigator || view?.navigator
      || (typeof navigator !== 'undefined' ? navigator : null);
    return { root, view, navigatorObject };
  },
  getMobileCapabilitySnapshot(snapshot = {}, rootEl) {
    const { root, view, navigatorObject } = this._viewportContext(rootEl);
    const maxTouchPoints = Number(navigatorObject?.maxTouchPoints) || 0;
    const touchSupported = maxTouchPoints > 0 || 'ontouchstart' in (view || {});
    const deviceClass = touchSupported
      ? 'touch'
      : (view?.PointerEvent ? 'pointer' : 'unknown');
    const viewportHeight = Math.max(0, Number(view?.innerHeight)
      || Number(root?.documentElement?.clientHeight) || 0);
    const visualViewport = view?.visualViewport;
    const visualHeight = Number(visualViewport?.height);
    const offsetTop = Number(visualViewport?.offsetTop) || 0;
    const keyboard = navigatorObject?.virtualKeyboard;
    const virtualKeyboardSupported = !!keyboard;
    const keyboardRectHeight = Number(keyboard?.boundingRect?.height);
    const visualInset = viewportHeight - (Number.isFinite(visualHeight)
      ? visualHeight : viewportHeight) - offsetTop;
    const rawInset = virtualKeyboardSupported && Number.isFinite(keyboardRectHeight)
      ? keyboardRectHeight : visualInset;
    const keyboardBottom = Math.round(Math.max(0, Math.min(viewportHeight, rawInset)));
    const result = {
      deviceClass,
      touchSupported,
      virtualKeyboardSupported,
      viewportHeight,
      visualViewportHeight: Number.isFinite(visualHeight) && visualHeight > 0
        ? visualHeight : viewportHeight,
      visualViewportOffsetTop: Number.isFinite(offsetTop) && offsetTop > 0 ? offsetTop : 0,
      keyboardRectHeight: Number.isFinite(keyboardRectHeight) && keyboardRectHeight >= 0
        ? keyboardRectHeight : 0,
      keyboardOverlay: virtualKeyboardSupported
        && keyboard?.overlaysContent === true
        && Number.isFinite(keyboardRectHeight) && keyboardRectHeight >= 0,
      keyboardBottom,
      keyboardInset: keyboardBottom,
      streamReady: snapshot.streamReady === true,
      activeControl: snapshot.activeControl === true,
      transportReady: snapshot.transportReady === true,
      mobileInputMode: ['off', 'armed', 'visible', 'blocked'].includes(snapshot.mobileInputMode)
        ? snapshot.mobileInputMode : 'off',
    };
    return Object.freeze(result);
  },
  setMobileKeyboardBottom(value, rootEl) {
    const { root } = this._viewportContext(rootEl);
    const viewportHeight = Number(this._mobileViewportSnapshot?.viewportHeight)
      || this.getMobileCapabilitySnapshot({}, root).viewportHeight;
    const keyboardBottom = Math.round(Math.max(0, Math.min(viewportHeight, Number(value) || 0)));
    const documentElement = root?.documentElement || root;
    const cssValue = `${keyboardBottom}px`;
    this._writeStyleValue(documentElement, '--mobile-keyboard-bottom', cssValue);
    return keyboardBottom;
  },
  syncMobileDockHeight(docksEl, rootEl) {
    const { root } = this._viewportContext(rootEl);
    const docks = docksEl || root?.getElementById?.('chromeDocks') || root?.querySelector?.('#chromeDocks');
    const rectHeight = Number(docks?.getBoundingClientRect?.().height);
    const offsetHeight = Number(docks?.offsetHeight);
    const measuredHeight = Number.isFinite(rectHeight) ? rectHeight : offsetHeight;
    const dockHeight = Math.max(0, Math.ceil(Number.isFinite(measuredHeight) ? measuredHeight : 0));
    const documentElement = root?.documentElement || root;
    const cssValue = `${dockHeight}px`;
    this._writeStyleValue(documentElement, '--mobile-dock-height', cssValue);
    return dockHeight;
  },
  _getElement(root, id, selector = `#${id}`) {
    return root?.getElementById?.(id) || root?.querySelector?.(selector) || null;
  },
  _readElementHeight(element) {
    const rectHeight = Number(element?.getBoundingClientRect?.().height);
    if (Number.isFinite(rectHeight) && rectHeight >= 0) return rectHeight;
    const offsetHeight = Number(element?.offsetHeight);
    return Number.isFinite(offsetHeight) && offsetHeight >= 0 ? offsetHeight : 0;
  },
  _readSafeAreaBottom(root) {
    const probe = this._getElement(root, 'mobileSafeAreaProbe');
    if (!probe) return 0;
    const view = root?.defaultView || root?.ownerDocument?.defaultView
      || (typeof window !== 'undefined' ? window : null);
    const getter = view?.getComputedStyle
      || (typeof getComputedStyle === 'function' ? getComputedStyle : null);
    let value = '';
    try {
      value = getter ? getter.call(view || globalThis, probe)?.paddingBottom : '';
    } catch (_) {
      value = '';
    }
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  },
  _isDesktopTabActive(root) {
    const body = root?.body || root?.querySelector?.('body');
    if (!body || body.classList?.contains?.('terminal-active')) return false;
    const panel = this._getElement(root, 'desktopPanel');
    if (!panel || panel.hidden || panel.classList?.contains?.('hidden')) return false;
    const desktopTab = this._getElement(root, 'desktopTabBtn');
    return desktopTab?.getAttribute?.('aria-selected') !== 'false';
  },
  _isVisible(element) {
    if (!element || element.hidden || element.classList?.contains?.('hidden')) return false;
    const style = element.style || {};
    return style.display !== 'none' && style.visibility !== 'hidden';
  },
  _readMobileTextVisible(root) {
    const textDock = this._getElement(root, 'mobileInputDock');
    if (textDock) return this._isVisible(textDock);
    const body = root?.body || root?.querySelector?.('body');
    return !!body?.classList?.contains?.('mobile-input-visible');
  },
  _getLayoutInputs(root, snapshot) {
    const { view, navigatorObject } = this._viewportContext(root);
    const layoutHeightRaw = Number(view?.innerHeight)
      || Number(root?.documentElement?.clientHeight) || 0;
    const layoutHeight = Number.isFinite(layoutHeightRaw) ? Math.max(0, layoutHeightRaw) : 0;
    const visualViewport = view?.visualViewport;
    const visualHeightRaw = Number(visualViewport?.height);
    const visualHeight = Number.isFinite(visualHeightRaw) && visualHeightRaw >= 0
      ? visualHeightRaw : layoutHeight;
    const offsetTopRaw = Number(visualViewport?.offsetTop);
    const offsetTop = Number.isFinite(offsetTopRaw) && offsetTopRaw >= 0 ? offsetTopRaw : 0;
    const keyboard = navigatorObject?.virtualKeyboard;
    const keyboardRectHeight = Number(keyboard?.boundingRect?.height);
    const keyboardOverlay = !!keyboard
      && keyboard.overlaysContent === true
      && Number.isFinite(keyboardRectHeight) && keyboardRectHeight >= 0;
    const status = this._getElement(root, 'statusBar');
    const docks = this._getElement(root, 'chromeDocks');
    const textDock = this._getElement(root, 'mobileInputDock');
    const textVisible = this._readMobileTextVisible(root);
    const measuredChromeTop = this._readElementHeight(status);
    const measuredDockContentHeight = this._readElementHeight(docks);
    return {
      layoutHeight,
      visualHeight,
      offsetTop,
      keyboardRectHeight: keyboardOverlay ? keyboardRectHeight : 0,
      keyboardOverlay,
      safeBottom: this._readSafeAreaBottom(root),
      chromeTop: this.effectiveChromeTop(measuredChromeTop, root),
      dockContentHeight: this.isFullscreenActive(root) ? 0 : measuredDockContentHeight,
      textDockHeight: textVisible ? this._readElementHeight(textDock) : 0,
      textVisible,
      touchSupported: snapshot.touchSupported === true,
    };
  },
  _applyBodyClass(body, className, enabled) {
    if (!body?.classList) return;
    const active = body.classList.contains?.(className) === true;
    if (enabled && !active) body.classList.add?.(className);
    if (!enabled && active) body.classList.remove?.(className);
  },
  _clearMobileLayoutOverrides(root) {
    const documentElement = root?.documentElement || root;
    MOBILE_LAYOUT_PROPERTIES.forEach((name) => this._removeStyleValue(documentElement, name));
  },
  _applyMobileLayout(root, layout, safeBottom, touchSupported = this._mobileViewportSnapshot?.touchSupported) {
    const body = root?.body || root?.querySelector?.('body');
    const managed = touchSupported === true && this._isDesktopTabActive(root);
    const wasCompact = body?.classList?.contains?.(MOBILE_LAYOUT_COMPACT_CLASS) === true;
    const moreButton = this._getElement(root, 'moreActionsBtn');
    const moreOpen = moreButton?.getAttribute?.('aria-expanded') === 'true';
    this._applyBodyClass(body, MOBILE_LAYOUT_CLASS, managed);
    this._applyBodyClass(body, MOBILE_LAYOUT_COMPACT_CLASS, managed && layout.compact);
    this._applyBodyClass(body, MOBILE_LAYOUT_ULTRA_CLASS, managed && layout.ultraCompact);
    this._applyBodyClass(body, MOBILE_LAYOUT_UNSUPPORTED_CLASS, managed && layout.unsupportedViewport);

    // Reparented compact controls belong to the existing More overlay only
    // while that layout is active.  Restore them before Terminal/non-touch or
    // non-compact desktop state can leave the menu as a stale DOM owner.
    if (moreOpen && wasCompact && (!managed || !layout.compact)) this.toggleMoreMenu(false, root);
    else if (moreOpen && managed && layout.compact && !wasCompact) this.toggleMoreMenu(true, root);

    if (!managed) {
      this._clearMobileLayoutOverrides(root);
      if (this._mobileLayoutLastSupported !== true) {
        if (typeof Input !== 'undefined') Input.setViewportInputSupported?.(true);
        this._mobileLayoutLastSupported = true;
      }
      return;
    }

    const documentElement = root?.documentElement || root;
    const textBottom = layout.bottomInset + Math.max(0, Number(safeBottom) || 0);
    const values = {
      '--mobile-visible-top': `${layout.visibleTop}px`,
      '--mobile-viewer-top': `${layout.viewerTop}px`,
      '--mobile-viewer-height': `${layout.viewerHeight}px`,
      '--mobile-dock-bottom': `${layout.dockBottom}px`,
      '--mobile-text-bottom': `${textBottom}px`,
    };
    Object.entries(values).forEach(([name, value]) => this._writeStyleValue(documentElement, name, value));
    const supported = layout.unsupportedViewport !== true;
    if (this._mobileLayoutLastSupported !== supported) {
      if (typeof Input !== 'undefined') Input.setViewportInputSupported?.(supported);
      this._mobileLayoutLastSupported = supported;
    }
  },
  _flushMobileLayout() {
    const pending = this._mobileLayoutPending;
    this._mobileLayoutPending = null;
    this._mobileLayoutRaf = null;
    if (!pending) return;
    this._applyMobileLayout(pending.root, pending.layout, pending.safeBottom, pending.touchSupported);
  },
  _queueMobileLayout(root, layout, safeBottom, touchSupported) {
    this._mobileLayoutPending = { root, layout, safeBottom, touchSupported };
    if (this._mobileLayoutRaf !== null) return;
    const view = root?.defaultView || (typeof window !== 'undefined' ? window : null);
    const request = view?.requestAnimationFrame
      || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
    if (typeof request !== 'function') {
      this._flushMobileLayout();
      return;
    }
    // Mark the slot before invoking RAF.  Some test/embedded DOM shims invoke
    // the callback synchronously and return undefined; assigning that return
    // value after the callback would otherwise strand the coalescing lock.
    const rafToken = {};
    this._mobileLayoutRaf = rafToken;
    const handle = request.call(view, () => {
      if (this._mobileLayoutRaf === rafToken) this._mobileLayoutRaf = null;
      this._flushMobileLayout();
    });
    if (this._mobileLayoutRaf === rafToken) this._mobileLayoutRaf = handle ?? rafToken;
  },
  recalculate(rootEl, { schedule = false } = {}) {
    const { root } = this._viewportContext(rootEl);
    const status = root?.getElementById?.('statusBar') || root?.querySelector?.('#statusBar');
    const chromeTop = this.effectiveChromeTop(this._readElementHeight(status), root);
    this.syncChromeTop(chromeTop, root);
    this.syncMobileDockHeight(null, root);
    const snapshot = this.getMobileCapabilitySnapshot(this._mobileViewportSnapshot || {}, root);
    this._mobileViewportSnapshot = snapshot;
    this.setMobileKeyboardBottom(snapshot.keyboardBottom, root);
    const inputs = this._getLayoutInputs(root, snapshot);
    const layout = this.computeMobileLayout(inputs);
    this._mobileLayoutResult = layout;
    if (schedule) this._queueMobileLayout(root, layout, inputs.safeBottom, inputs.touchSupported);
    else this._applyMobileLayout(root, layout, inputs.safeBottom, inputs.touchSupported);
    return snapshot;
  },
  observeMobileLayout(rootEl) {
    const { root } = this._viewportContext(rootEl);
    this._mobileLayoutCleanup?.();
    const body = root?.body || root?.querySelector?.('body');
    const panel = this._getElement(root, 'desktopPanel');
    const desktopTab = this._getElement(root, 'desktopTabBtn');
    const terminalTab = this._getElement(root, 'terminalTabBtn');
    const listeners = [];
    const observe = (target, options) => {
      if (!target || typeof MutationObserver === 'undefined') return null;
      const observer = new MutationObserver(() => this.recalculate(root, { schedule: true }));
      observer.observe(target, options);
      listeners.push(observer);
      return observer;
    };
    observe(body, { attributes: true, attributeFilter: ['class'] });
    observe(panel, { attributes: true, attributeFilter: ['class', 'hidden'] });
    observe(desktopTab, { attributes: true, attributeFilter: ['class', 'aria-selected'] });
    observe(terminalTab, { attributes: true, attributeFilter: ['class', 'aria-selected'] });
    this.recalculate(root, { schedule: true });
    const cleanup = () => {
      listeners.splice(0).forEach((observer) => observer.disconnect?.());
      if (this._mobileLayoutRaf !== null) {
        const view = root?.defaultView || (typeof window !== 'undefined' ? window : null);
        view?.cancelAnimationFrame?.(this._mobileLayoutRaf);
        this._mobileLayoutRaf = null;
      }
      this._mobileLayoutPending = null;
      if (this._mobileLayoutCleanup === cleanup) this._mobileLayoutCleanup = null;
    };
    this._mobileLayoutCleanup = cleanup;
    return cleanup;
  },
  observeMobileViewport(rootEl) {
    const { root, view, navigatorObject } = this._viewportContext(rootEl);
    this._mobileViewportCleanup?.();
    const listeners = [];
    const addListener = (target, type, handler) => {
      if (!target?.addEventListener) return;
      target.addEventListener(type, handler);
      listeners.push([target, type, handler]);
    };
    const update = () => this.recalculate(root, { schedule: true });
    const keyboard = navigatorObject?.virtualKeyboard;
    if (keyboard) {
      try { keyboard.overlaysContent = true; } catch (_) { /* optional API */ }
      addListener(keyboard, 'geometrychange', update);
    }
    addListener(view?.visualViewport, 'resize', update);
    addListener(view?.visualViewport, 'scroll', update);
    addListener(view, 'resize', update);
    update();
    const cleanup = () => {
      listeners.splice(0).forEach(([target, type, handler]) => {
        target.removeEventListener?.(type, handler);
      });
      if (this._mobileViewportCleanup === cleanup) this._mobileViewportCleanup = null;
    };
    this._mobileViewportCleanup = cleanup;
    return cleanup;
  },
  observeMobileDocks(rootEl) {
    const { root } = this._viewportContext(rootEl);
    this._mobileDockCleanup?.();
    const docks = root?.getElementById?.('chromeDocks') || root?.querySelector?.('#chromeDocks');
    const textDock = this._getElement(root, 'mobileInputDock');
    const update = () => {
      this.syncMobileDockHeight(docks, root);
      this.recalculate(root, { schedule: true });
    };
    update();
    const observer = docks && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(update) : null;
    observer?.observe(docks);
    if (textDock && observer) observer.observe(textDock);
    const cleanup = () => {
      observer?.disconnect();
      if (this._mobileDockCleanup === cleanup) this._mobileDockCleanup = null;
    };
    this._mobileDockCleanup = cleanup;
    return cleanup;
  },
  getCapabilities(snapshot = {}) {
    const phase = ['idle', 'signaling', 'media-pending', 'connected', 'media-stalled', 'disconnected']
      .includes(snapshot.uiPhase) ? snapshot.uiPhase : 'idle';
    const active = snapshot.activeControl === true && snapshot.controlTransition !== true;
    const mediaReady = snapshot.streamReady === true && phase === 'connected';
    const canConnect = phase === 'idle' || phase === 'disconnected';
    const canMediaActions = phase === 'media-pending' || phase === 'connected' || phase === 'media-stalled';
    return {
      canConnect,
      canSendDesktopInput: mediaReady && active,
      canRefresh: canMediaActions,
      canPause: phase === 'connected' || phase === 'media-stalled',
      canDisconnect: canMediaActions,
      canOpenNetwork: phase !== 'idle',
      canOpenResolution: phase === 'connected' || phase === 'media-stalled',
      canOpenTerminal: phase !== 'idle' && phase !== 'disconnected',
    };
  },
  applyCapabilities(snapshot = {}, rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    const mobileSnapshot = this.getMobileCapabilitySnapshot(snapshot, root);
    this._mobileViewportSnapshot = mobileSnapshot;
    this.setMobileKeyboardBottom(mobileSnapshot.keyboardBottom, root);
    const capabilities = this.getCapabilities(snapshot);
    const phase = ['idle', 'signaling', 'media-pending', 'connected', 'media-stalled', 'disconnected']
      .includes(snapshot.uiPhase) ? snapshot.uiPhase : 'idle';
    if (!root) return capabilities;
    const setNode = (id, allowed, { hide = true } = {}) => {
      const node = root.getElementById?.(id) || root.querySelector?.(`#${id}`);
      if (!node) return;
      node.disabled = !allowed;
      if (hide) node.hidden = !allowed;
    };
    Object.entries(CAPABILITY_IDS).forEach(([capability, ids]) => {
      ids.forEach((id) => {
        let allowed = capabilities[capability] === true;
        if (id === 'requestControlBtn') {
          allowed = ['connected', 'media-stalled'].includes(snapshot.uiPhase)
            && snapshot.activeControl !== true && snapshot.controlTransition !== true;
        }
        setNode(id, allowed, { hide: !['requestControlBtn', 'terminalTabBtn'].includes(id) });
      });
    });
    setNode('requestControlBtn', snapshot.streamReady === true
      && phase === 'connected'
      && snapshot.activeControl !== true && snapshot.controlTransition !== true);
    setNode('terminalTabBtn', capabilities.canOpenTerminal, { hide: false });
    const mediaReady = snapshot.streamReady === true && ['connected', 'media-stalled'].includes(snapshot.uiPhase);
    MEDIA_CONTROL_IDS.forEach((id) => setNode(id, mediaReady));
    setNode('moreActionsBtn', mediaReady, { hide: false });
    const actionNodes = root.querySelectorAll?.('[data-action]') || [];
    actionNodes.forEach((node) => {
      node.disabled = !capabilities.canSendDesktopInput;
      node.hidden = !capabilities.canSendDesktopInput;
    });
    const mobileActionNodes = root.querySelectorAll?.('[data-mobile-action]') || [];
    mobileActionNodes.forEach((node) => {
      // A latched virtual modifier must remain a real, visible button so the
      // operator can release it even after media/capability gating closes.
      // The click handler still blocks a new ON transition through its local
      // editing gate.
      const modifierPressed = node.getAttribute?.('aria-pressed') === 'true';
      const allowed = capabilities.canSendDesktopInput || modifierPressed;
      node.disabled = !allowed;
      node.hidden = !allowed;
    });
    const loading = root.getElementById?.('loading') || root.querySelector?.('#loading');
    if (loading?.classList?.toggle) loading.classList.toggle('is-connecting', phase === 'signaling');
    if (loading?.style) loading.style.pointerEvents = phase === 'signaling' ? 'auto' : 'none';
    return capabilities;
  },
  observeStatusBar(statusEl, rootEl) {
    if (!statusEl) return () => {};
    if (typeof ResizeObserver === 'undefined') {
      this.recalculate(rootEl, { schedule: true });
      return () => {};
    }
    const apply = () => {
      this.recalculate(rootEl, { schedule: true });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(statusEl);
    return () => ro.disconnect();
  },
  nextMoreMenuState(isOpen) {
    return { open: !isOpen };
  },
  recordOverflowHomeIndexes(bar) {
    if (!bar?.querySelectorAll) return;
    const actionBtns = bar.querySelectorAll('.action-btn:not(.action-more)');
    actionBtns.forEach((btn, index) => {
      if (btn.getAttribute('data-pin') === 'always') return;
      btn.setAttribute('data-home-index', String(index));
    });
  },
  recordControlHomeIndexes(controlBar) {
    if (!controlBar?.querySelectorAll) return;
    controlBar.querySelectorAll('.control-btn').forEach((btn, index) => {
      btn.setAttribute('data-control-home-index', String(index));
    });
  },
  moveOverflowIntoMenu(bar, menu) {
    if (!bar || !menu) return;
    const overflow = Array.from(bar.querySelectorAll(OVERFLOW_ACTION_SELECTOR));
    overflow.forEach((btn) => {
      btn.setAttribute?.('role', 'menuitem');
      menu.appendChild(btn);
    });
  },
  moveControlBarIntoMenu(controlBar, menu) {
    if (!controlBar || !menu) return;
    Array.from(controlBar.querySelectorAll?.('.control-btn') || []).forEach((btn) => {
      btn.setAttribute?.('role', 'menuitem');
      menu.appendChild(btn);
    });
  },
  restoreOverflowToBar(bar, menu) {
    if (!bar || !menu) return;
    const moreBtn = bar.querySelector('#moreActionsBtn') || bar.querySelector('.action-more');
    const items = Array.from(menu.querySelectorAll('.action-btn'))
      .sort((a, b) => Number(a.getAttribute('data-home-index')) - Number(b.getAttribute('data-home-index')));
    items.forEach((btn) => {
      btn.removeAttribute?.('role');
      const target = Number(btn.getAttribute('data-home-index'));
      const current = Array.from(bar.children).filter((child) =>
        child.classList?.contains('action-btn') && !child.classList.contains('action-more')
      );
      const ref = Number.isFinite(target) ? (current[target] || moreBtn) : moreBtn;
      bar.insertBefore(btn, ref || null);
    });
  },
  restoreControlBarFromMenu(controlBar, menu) {
    if (!controlBar || !menu) return;
    const items = Array.from(menu.querySelectorAll?.('.control-btn') || [])
      .sort((a, b) => Number(a.getAttribute('data-control-home-index'))
        - Number(b.getAttribute('data-control-home-index')));
    items.forEach((btn) => {
      btn.removeAttribute?.('role');
      const target = Number(btn.getAttribute('data-control-home-index'));
      const children = Array.from(controlBar.children || []);
      const ref = Number.isFinite(target) ? (children[target] || null) : null;
      controlBar.insertBefore(btn, ref);
    });
  },
  _isManagedCompact(root) {
    const body = root?.body || root?.querySelector?.('body');
    return body?.classList?.contains?.(MOBILE_LAYOUT_CLASS) === true
      && body?.classList?.contains?.(MOBILE_LAYOUT_COMPACT_CLASS) === true;
  },
  toggleMoreMenu(open, rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    if (!root) return { open: !!open };
    const btn = root.getElementById?.('moreActionsBtn') || root.querySelector?.('#moreActionsBtn');
    const menu = root.getElementById?.('moreActionsMenu') || root.querySelector?.('#moreActionsMenu');
    const bar = root.querySelector?.('.action-bar');
    const controlBar = root.querySelector?.('.control-bar');
    const body = root.body || root.querySelector?.('body');
    if (!btn || !menu || !bar) return { open: !!open };
    const current = btn.getAttribute('aria-expanded') === 'true';
    const nextOpen = typeof open === 'boolean' ? open : this.nextMoreMenuState(current).open;
    btn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    menu.hidden = !nextOpen;
    body?.classList?.toggle?.('more-open', nextOpen);
    if (nextOpen) {
      this.moveOverflowIntoMenu(bar, menu);
      if (this._isManagedCompact(root)) this.moveControlBarIntoMenu(controlBar, menu);
    } else {
      this.restoreControlBarFromMenu(controlBar, menu);
      this.restoreOverflowToBar(bar, menu);
    }
    return { open: nextOpen };
  },
  handleMoreMenuKeydown(event, rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    const menu = root?.getElementById?.('moreActionsMenu') || root?.querySelector?.('#moreActionsMenu');
    if (!menu || menu.hidden) return false;
    const items = Array.from(menu.querySelectorAll?.('[role="menuitem"], .action-btn') || []);
    if (!items.length) return false;
    const current = items.indexOf(root?.activeElement || event?.target);
    let next = current;
    if (event?.key === 'ArrowDown') next = current < items.length - 1 ? current + 1 : 0;
    else if (event?.key === 'ArrowUp') next = current > 0 ? current - 1 : items.length - 1;
    else if (event?.key === 'Home') next = 0;
    else if (event?.key === 'End') next = items.length - 1;
    else return false;
    event.preventDefault?.();
    items[next]?.focus?.();
    return true;
  },
  bindMoreMenu(rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    if (!root) return () => {};
    const bar = root.querySelector?.('.action-bar');
    const btn = root.getElementById?.('moreActionsBtn') || root.querySelector?.('#moreActionsBtn');
    const docks = root.getElementById?.('chromeDocks') || root.querySelector?.('#chromeDocks');
    this.recordOverflowHomeIndexes(bar);
    this.recordControlHomeIndexes(root.querySelector?.('.control-bar'));
    if (!btn) return () => {};

    const onBtnClick = (event) => {
      event.preventDefault();
      const isOpen = btn.getAttribute('aria-expanded') === 'true';
      this.toggleMoreMenu(this.nextMoreMenuState(isOpen).open, root);
    };
    const onKeydown = (event) => {
      if (this.handleMoreMenuKeydown(event, root)) return;
      if (event.key !== 'Escape') return;
      if (btn.getAttribute('aria-expanded') !== 'true') return;
      this.toggleMoreMenu(false, root);
    };
    const onPointerDown = (event) => {
      if (btn.getAttribute('aria-expanded') !== 'true') return;
      const target = event.target;
      if (docks && typeof docks.contains === 'function' && docks.contains(target)) return;
      this.toggleMoreMenu(false, root);
    };

    btn.addEventListener('click', onBtnClick);
    root.addEventListener?.('keydown', onKeydown);
    root.addEventListener?.('pointerdown', onPointerDown);
    return () => {
      btn.removeEventListener('click', onBtnClick);
      root.removeEventListener?.('keydown', onKeydown);
      root.removeEventListener?.('pointerdown', onPointerDown);
    };
  },
};

if (typeof globalThis !== 'undefined') globalThis.ChromeLayout = ChromeLayout;
if (typeof module !== 'undefined' && module.exports) module.exports = { ChromeLayout };
