const OVERFLOW_ACTION_SELECTOR = '.action-btn:not(.action-more):not([data-pin="always"])';
const IDLE_EDGE_PX = 80;

const ChromeLayout = {
  IDLE_MS: 2500,
  autoIdleEnabled: false,
  _lastActivity: 0,
  _idleTimer: null,
  _wasStreamConnected: false,
  _wasControlsHidden: false,
  init() {
    const statusEl = typeof document !== 'undefined' ? document.getElementById('statusBar') : null;
    const unobserve = this.observeStatusBar(statusEl);
    const unbindMore = this.bindMoreMenu();
    const unbindIdle = this.bindIdle();
    this.syncToggleControlsLabel();
    return () => {
      unobserve();
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
    root?.style?.setProperty('--chrome-top', `${Math.round(height)}px`);
  },
  observeStatusBar(statusEl, rootEl) {
    if (!statusEl || typeof ResizeObserver === 'undefined') return () => {};
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
    overflow.forEach((btn) => menu.appendChild(btn));
  },
  restoreOverflowToBar(bar, menu) {
    if (!bar || !menu) return;
    const moreBtn = bar.querySelector('#moreActionsBtn') || bar.querySelector('.action-more');
    const items = Array.from(menu.querySelectorAll('.action-btn'))
      .sort((a, b) => Number(a.getAttribute('data-home-index')) - Number(b.getAttribute('data-home-index')));
    items.forEach((btn) => {
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
