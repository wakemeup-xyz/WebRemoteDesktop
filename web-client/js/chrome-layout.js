const OVERFLOW_ACTION_SELECTOR = '.action-btn:not(.action-more):not([data-pin="always"])';

const ChromeLayout = {
  init() {
    const statusEl = typeof document !== 'undefined' ? document.getElementById('statusBar') : null;
    const unobserve = this.observeStatusBar(statusEl);
    const unbindMore = this.bindMoreMenu();
    return () => {
      unobserve();
      unbindMore();
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
