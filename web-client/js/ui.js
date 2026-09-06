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
    const video = document.getElementById('remoteVideo');
    const relayImage = document.getElementById('relayImage');
    const fullscreenTarget = document.documentElement;

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

    const preserveEditingFocusOnPointerDown = (event) => {
      const active = document.activeElement;
      const isEditing = active?.isContentEditable === true
        || active?.matches?.('input,textarea,select,[contenteditable="true"]')
        || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active?.tagName);
      if (isEditing) event.preventDefault?.();
    };

    const isDocumentFullscreen = () => fullscreenTarget
      ? document.fullscreenElement === fullscreenTarget
      : Boolean(document.fullscreenElement);

    const exitFullscreen = async () => {
      if (typeof document.exitFullscreen !== 'function') {
        setFullscreenStatus('不支持全屏，可继续操作');
        return false;
      }
      try {
        await document.exitFullscreen();
        return true;
      } catch (err) {
        setFullscreenStatus('不支持全屏，可继续操作');
        return false;
      }
    };

    if (exitFullscreenBtn) {
      exitFullscreenBtn.addEventListener('pointerdown', preserveEditingFocusOnPointerDown);
      exitFullscreenBtn.addEventListener('click', (event) => {
        event.preventDefault?.();
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
      if (isFullscreen) setFullscreenStatus('');
      if (typeof ChromeLayout !== 'undefined' && typeof ChromeLayout.recalculate === 'function') {
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
