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
  init() {
    const statusEl = typeof document !== 'undefined' ? document.getElementById('statusBar') : null;
    const unobserve = this.observeStatusBar(statusEl);
    const unobserveViewport = this.observeMobileViewport();
    const unobserveDocks = this.observeMobileDocks();
    const unbindMore = this.bindMoreMenu();
    const unbindIdle = this.bindIdle();
    this.syncToggleControlsLabel();
    return () => {
      unobserve();
      unobserveViewport();
      unobserveDocks();
      unbindMore();
      unbindIdle();
    };
  },
  docksAreAway(body) {
    return !!body?.classList?.contains?.('controls-hidden')
      || !!body?.classList?.contains?.('chrome-idle');
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
  shouldIdle({ streamConnected, controlsHidden, menuOpen, modalOpen, idleMs } = {}) {
    return !!streamConnected
      && !controlsHidden
      && !menuOpen
      && !modalOpen
      && Number(idleMs) >= this.IDLE_MS;
  },
  collectIdleInputs(rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    const body = root?.body || root?.querySelector?.('body');
    const moreBtn = root?.getElementById?.('moreActionsBtn') || root?.querySelector?.('#moreActionsBtn');
    const menuOpen = !!body?.classList?.contains?.('more-open')
      || moreBtn?.getAttribute?.('aria-expanded') === 'true';
    return {
      streamConnected: !!body?.classList?.contains?.('stream-connected'),
      controlsHidden: !!body?.classList?.contains?.('controls-hidden'),
      menuOpen,
      modalOpen: !!root?.querySelector?.('.modal:not(.hidden)'),
      idleMs: Date.now() - (this._lastActivity || 0),
    };
  },
  enterIdle(rootEl) {
    if (!this.autoIdleEnabled) return;
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    const body = root?.body || root?.querySelector?.('body');
    body?.classList?.add?.('chrome-idle');
    this.syncToggleControlsLabel(root);
    const advisor = root?.getElementById?.('networkAdvisor') || root?.querySelector?.('#networkAdvisor');
    if (advisor?.classList?.contains?.('visible')) advisor.classList.add('collapsed');
  },
  bump(rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
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
    this.clearIdleTimer();
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    this._idleTimer = setTimeout(() => {
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
      const inputs = this.collectIdleInputs(root);
      const connectedBecame = inputs.streamConnected && !this._wasStreamConnected;
      const unhid = this._wasControlsHidden && !inputs.controlsHidden;
      this._wasStreamConnected = inputs.streamConnected;
      this._wasControlsHidden = inputs.controlsHidden;
      if (body?.classList?.contains?.('chrome-idle')
          && (!inputs.streamConnected || inputs.controlsHidden || inputs.menuOpen || inputs.modalOpen)) {
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
  syncChromeTop(px, rootEl) {
    const height = Number(px);
    if (!Number.isFinite(height) || height <= 0) return;
    const root = rootEl || (typeof document !== 'undefined' ? document.documentElement : null);
    const value = `${Math.round(height)}px`;
    if (typeof root?.style?.setProperty === 'function') root.style.setProperty('--chrome-top', value);
    else if (root?.style) root.style['--chrome-top'] = value;
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
    if (typeof documentElement?.style?.setProperty === 'function') {
      documentElement.style.setProperty('--mobile-keyboard-bottom', cssValue);
    } else if (documentElement?.style) {
      documentElement.style['--mobile-keyboard-bottom'] = cssValue;
    }
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
    if (typeof documentElement?.style?.setProperty === 'function') {
      documentElement.style.setProperty('--mobile-dock-height', cssValue);
    } else if (documentElement?.style) {
      documentElement.style['--mobile-dock-height'] = cssValue;
    }
    return dockHeight;
  },
  recalculate(rootEl) {
    const { root } = this._viewportContext(rootEl);
    const status = root?.getElementById?.('statusBar') || root?.querySelector?.('#statusBar');
    this.syncChromeTop(status?.offsetHeight || 56, root);
    this.syncMobileDockHeight(null, root);
    const snapshot = this.getMobileCapabilitySnapshot(this._mobileViewportSnapshot || {}, root);
    this._mobileViewportSnapshot = snapshot;
    this.setMobileKeyboardBottom(snapshot.keyboardBottom, root);
    return snapshot;
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
    const update = () => {
      this.recalculate(root);
    };
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
    const update = () => this.syncMobileDockHeight(docks, root);
    update();
    const observer = docks && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(update) : null;
    observer?.observe(docks);
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
      node.disabled = !capabilities.canSendDesktopInput;
      node.hidden = !capabilities.canSendDesktopInput;
    });
    const loading = root.getElementById?.('loading') || root.querySelector?.('#loading');
    if (loading?.classList?.toggle) loading.classList.toggle('is-connecting', phase === 'signaling');
    if (loading?.style) loading.style.pointerEvents = phase === 'signaling' ? 'auto' : 'none';
    return capabilities;
  },
  observeStatusBar(statusEl, rootEl) {
    if (!statusEl) return () => {};
    if (typeof ResizeObserver === 'undefined') {
      this.syncChromeTop(56, rootEl);
      return () => {};
    }
    const apply = () => this.syncChromeTop(statusEl.offsetHeight, rootEl);
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
  moveOverflowIntoMenu(bar, menu) {
    if (!bar || !menu) return;
    const overflow = Array.from(bar.querySelectorAll(OVERFLOW_ACTION_SELECTOR));
    overflow.forEach((btn) => {
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
  toggleMoreMenu(open, rootEl) {
    const root = rootEl || (typeof document !== 'undefined' ? document : null);
    if (!root) return { open: !!open };
    const btn = root.getElementById?.('moreActionsBtn') || root.querySelector?.('#moreActionsBtn');
    const menu = root.getElementById?.('moreActionsMenu') || root.querySelector?.('#moreActionsMenu');
    const bar = root.querySelector?.('.action-bar');
    const body = root.body || root.querySelector?.('body');
    if (!btn || !menu || !bar) return { open: !!open };
    const current = btn.getAttribute('aria-expanded') === 'true';
    const nextOpen = typeof open === 'boolean' ? open : this.nextMoreMenuState(current).open;
    btn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    menu.hidden = !nextOpen;
    body?.classList?.toggle?.('more-open', nextOpen);
    if (nextOpen) this.moveOverflowIntoMenu(bar, menu);
    else this.restoreOverflowToBar(bar, menu);
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
