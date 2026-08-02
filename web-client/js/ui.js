const UI = {
  init() {
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
    const video = document.getElementById('remoteVideo');
    const relayImage = document.getElementById('relayImage');
    const viewerContainer = document.querySelector('.viewer-container');

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

    if (fullscreenBtn && viewerContainer) {
      fullscreenBtn.addEventListener('click', async () => {
        try {
          if (!document.fullscreenElement) {
            await viewerContainer.requestFullscreen();
          } else {
            await document.exitFullscreen();
          }
        } catch (err) {
          console.error('Fullscreen toggle failed:', err);
        }
      });

      document.addEventListener('fullscreenchange', () => {
        const isFullscreen = document.fullscreenElement === viewerContainer;
        fullscreenBtn.textContent = isFullscreen ? '退出全屏' : '全屏';
        document.body.classList.toggle('fullscreen-active', isFullscreen);
        if (isFullscreen) {
          video.focus();
        }
      });
    }

    const toggleControlsBtn = document.getElementById('toggleControlsBtn');
    if (toggleControlsBtn) {
      toggleControlsBtn.addEventListener('click', () => {
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
