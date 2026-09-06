const UI = {
  getDesktopSessionSnapshot() {
    return typeof WebRTC !== 'undefined' && typeof WebRTC.getDesktopSessionSnapshot === 'function'
      ? WebRTC.getDesktopSessionSnapshot()
      : null;
  },

  canUseDesktopControls() {
    const snapshot = this.getDesktopSessionSnapshot();
    return snapshot ? snapshot.canInput === true : false;
  },

  init() {
    if (typeof ChromeLayout !== 'undefined') ChromeLayout.init();
    this.setupResolutionModal();
    this.setupControlButtons();
  },
  
  setupResolutionModal() {
    // webrtc.js owns open/apply/close handlers for the resolution modal.
    // UI only keeps the adaptive-resolution checkbox in sync.
    const adaptiveToggle = document.getElementById('adaptiveResolutionToggle');
    if (adaptiveToggle && !adaptiveToggle.dataset.boundUi) {
      adaptiveToggle.dataset.boundUi = '1';
      if (typeof WebRTC !== 'undefined') {
        adaptiveToggle.checked = WebRTC.adaptiveResolutionEnabled === true;
      }
      adaptiveToggle.addEventListener('change', () => {
        if (typeof WebRTC !== 'undefined' && typeof WebRTC.setAdaptiveResolutionEnabled === 'function') {
          WebRTC.setAdaptiveResolutionEnabled(adaptiveToggle.checked);
        }
      });
    }
  },
  
  setupControlButtons() {
    const pauseBtn = document.getElementById('pauseBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    const scaleBtn = document.getElementById('scaleBtn');
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const exitFullscreenBtn = document.getElementById('exitFullscreenBtn');
    const fullscreenStatus = document.getElementById('fullscreenStatus');
    const fullscreenExitStatus = document.getElementById('fullscreenExitStatus');
    const fullscreenExitPanel = document.getElementById('fullscreenExitPanel');
    const fullscreenExitRevealBtn = document.getElementById('fullscreenExitRevealBtn');
    const statusBar = document.getElementById('statusBar');
    const chromeDocks = document.getElementById('chromeDocks');
    const video = document.getElementById('remoteVideo');
    const relayImage = document.getElementById('relayImage');
    const fullscreenTarget = document.documentElement;
    const FULLSCREEN_EXIT_REVEAL_MS = 4000;
    let revealTimer = null;
    const fullscreenInertAdded = new Set();

    const scaleModes = ['contain', 'cover', 'fill'];
    const scaleLabels = ['自适应', '填充', '拉伸'];
    let scaleIndex = 0;

    if (pauseBtn) pauseBtn.addEventListener('click', () => {
      if (typeof WebRTC === 'undefined' || typeof WebRTC.setMediaActivityReason !== 'function') {
        return;
      }
      const snapshot = typeof WebRTC.getMediaActivitySnapshot === 'function'
        ? WebRTC.getMediaActivitySnapshot()
        : { reasons: [] };
      const manuallyPaused = snapshot.reasons?.includes('manual-pause');
      WebRTC.setMediaActivityReason('manual-pause', !manuallyPaused);
      pauseBtn.textContent = manuallyPaused ? '暂停' : '恢复';
    });

    if (disconnectBtn) disconnectBtn.addEventListener('click', () => {
      if (confirm('确定要断开桌面连接吗？这不会关闭共享控制台。')) {
        WebRTC.disconnect();
      }
    });

    if (scaleBtn) {
      scaleBtn.addEventListener('click', () => {
        scaleIndex = (scaleIndex + 1) % scaleModes.length;
        const mode = scaleModes[scaleIndex];
        [video, relayImage].forEach((el) => el?.classList.remove('scale-cover', 'scale-fill'));
        if (mode === 'cover') {
          [video, relayImage].forEach((el) => el?.classList.add('scale-cover'));
        } else if (mode === 'fill') {
          [video, relayImage].forEach((el) => el?.classList.add('scale-fill'));
        }
        scaleBtn.textContent = `缩放：${scaleLabels[scaleIndex]}`;
      });
    }

    const setFullscreenStatus = (message) => {
      if (fullscreenStatus) {
        fullscreenStatus.textContent = message;
        fullscreenStatus.hidden = !message;
      }
    };

    const setFullscreenExitStatus = (message) => {
      if (fullscreenExitStatus) {
        fullscreenExitStatus.textContent = message;
        fullscreenExitStatus.hidden = !message;
      }
    };

    const preserveEditingFocusOnPointerDown = (event) => {
      const active = document.activeElement;
      const isEditing = active?.isContentEditable === true
        || active?.matches?.('input,textarea,select,[contenteditable="true"]')
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName);
      if (isEditing) event.preventDefault?.();
    };

    const isDocumentFullscreen = () => document.fullscreenElement === document.documentElement;

    const hasInert = (element) => element?.inert === true || element?.hasAttribute?.('inert') === true;

    const setInert = (element, active) => {
      if (!element) return;
      if (active) {
        element.inert = true;
        element.setAttribute?.('inert', '');
        return;
      }
      element.inert = false;
      element.removeAttribute?.('inert');
    };

    const syncFullscreenInert = (isFullscreen) => {
      if (isFullscreen) {
        [statusBar, chromeDocks].filter(Boolean).forEach((element) => {
          if (!hasInert(element)) {
            fullscreenInertAdded.add(element);
            setInert(element, true);
          }
        });
        return;
      }
      fullscreenInertAdded.forEach((element) => setInert(element, false));
      fullscreenInertAdded.clear();
    };

    const hideFullscreenExit = () => {
      if (revealTimer !== null) {
        clearTimeout(revealTimer);
        revealTimer = null;
      }
      if (fullscreenExitPanel) fullscreenExitPanel.hidden = true;
      fullscreenExitRevealBtn?.setAttribute?.('aria-expanded', 'false');
    };

    const revealFullscreenExit = () => {
      if (!isDocumentFullscreen()) return;
      if (revealTimer !== null) clearTimeout(revealTimer);
      if (fullscreenExitPanel) fullscreenExitPanel.hidden = false;
      fullscreenExitRevealBtn?.setAttribute?.('aria-expanded', 'true');
      revealTimer = setTimeout(() => {
        revealTimer = null;
        if (fullscreenExitPanel) fullscreenExitPanel.hidden = true;
        fullscreenExitRevealBtn?.setAttribute?.('aria-expanded', 'false');
      }, FULLSCREEN_EXIT_REVEAL_MS);
    };

    const exitFullscreen = async () => {
      if (typeof document.exitFullscreen !== 'function') {
        setFullscreenStatus('不支持全屏，可继续操作');
        setFullscreenExitStatus('不支持全屏，可继续操作');
        revealFullscreenExit();
        return false;
      }
      try {
        await document.exitFullscreen();
        return true;
      } catch (err) {
        setFullscreenStatus('不支持全屏，可继续操作');
        setFullscreenExitStatus('不支持全屏，可继续操作');
        revealFullscreenExit();
        return false;
      }
    };

    const consumeFullscreenOverlayEvent = (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
      revealFullscreenExit();
    };

    if (fullscreenExitRevealBtn) {
      fullscreenExitRevealBtn.addEventListener('pointerdown', consumeFullscreenOverlayEvent);
      fullscreenExitRevealBtn.addEventListener('click', consumeFullscreenOverlayEvent);
      fullscreenExitRevealBtn.addEventListener('focus', revealFullscreenExit);
    }

    if (exitFullscreenBtn) {
      exitFullscreenBtn.addEventListener('pointerdown', (event) => {
        preserveEditingFocusOnPointerDown(event);
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
      });
      exitFullscreenBtn.addEventListener('click', (event) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        event.stopImmediatePropagation?.();
        if (isDocumentFullscreen()) void exitFullscreen();
      });
    }

    const updateFullscreenState = () => {
      const isFullscreen = isDocumentFullscreen();
      if (fullscreenBtn) {
        fullscreenBtn.textContent = isFullscreen ? '退出全屏' : '全屏';
        fullscreenBtn.setAttribute?.('aria-pressed', String(isFullscreen));
      }
      document.body.classList.toggle('fullscreen-active', isFullscreen);
      syncFullscreenInert(isFullscreen);
      if (isFullscreen) {
        setFullscreenStatus('');
        setFullscreenExitStatus('');
        revealFullscreenExit();
      } else {
        hideFullscreenExit();
        setFullscreenExitStatus('');
      }
      if (typeof ChromeLayout !== 'undefined' && typeof ChromeLayout.setFullscreenActive === 'function') {
        ChromeLayout.setFullscreenActive(isFullscreen);
      } else if (typeof ChromeLayout !== 'undefined' && typeof ChromeLayout.recalculate === 'function') {
        ChromeLayout.recalculate();
      }
    };

    if (fullscreenBtn) {
      fullscreenBtn.addEventListener('pointerdown', preserveEditingFocusOnPointerDown);
      fullscreenBtn.addEventListener('click', async () => {
        try {
          if (isDocumentFullscreen()) {
            await exitFullscreen();
            return;
          }
          if (typeof fullscreenTarget?.requestFullscreen !== 'function') {
            setFullscreenStatus('不支持全屏，可继续操作');
            return;
          }
          await fullscreenTarget.requestFullscreen();
        } catch (err) {
          setFullscreenStatus('不支持全屏，可继续操作');
        }
      });

      document.addEventListener('fullscreenchange', updateFullscreenState);
      updateFullscreenState();
    }

    const toggleControlsBtn = document.getElementById('toggleControlsBtn');
    if (toggleControlsBtn) {
      toggleControlsBtn.addEventListener('click', () => {
        if (typeof ChromeLayout !== 'undefined' && typeof ChromeLayout.onToggleControlsClick === 'function') {
          ChromeLayout.onToggleControlsClick();
          return;
        }
        document.body.classList.toggle('controls-hidden');
        const hidden = document.body.classList.contains('controls-hidden');
        toggleControlsBtn.textContent = hidden ? '显示控件' : '隐藏控件';
      });
    }
  }
};

document.addEventListener('DOMContentLoaded', () => {
  UI.init();
});
