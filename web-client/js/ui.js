const UI = {
  init() {
    this.setupResolutionModal();
    this.setupControlButtons();
  },
  
  setupResolutionModal() {
    const resolutionBtn = document.getElementById('resolutionBtn');
    const modal = document.getElementById('resolutionModal');
    const applyBtn = document.getElementById('applyResolution');
    const closeBtn = document.getElementById('closeResolution');
    
    resolutionBtn.addEventListener('click', () => {
      modal.classList.remove('hidden');
    });
    
    closeBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
    });
    
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });
    
    applyBtn.addEventListener('click', () => {
      const selected = document.querySelector('input[name="resolution"]:checked');
      if (selected) {
        const width = parseInt(selected.dataset.width);
        const height = parseInt(selected.dataset.height);
        
        if (typeof WebRTC !== 'undefined') {
          WebRTC.requestResolution(width, height);
        }
        
        document.getElementById('resolutionDisplay').textContent = 
          `${selected.value} (${width}x${height})`;
        
        modal.classList.add('hidden');
      }
    });
  },
  
  setupControlButtons() {
    const pauseBtn = document.getElementById('pauseBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    const scaleBtn = document.getElementById('scaleBtn');
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const video = document.getElementById('remoteVideo');
    const relayImage = document.getElementById('relayImage');
    const viewerContainer = document.querySelector('.viewer-container');

    let isPaused = false;
    const scaleModes = ['contain', 'cover', 'fill'];
    const scaleLabels = ['自适应', '填充', '拉伸'];
    let scaleIndex = 0;

    pauseBtn.addEventListener('click', () => {
      if (isPaused) {
        video.play();
        pauseBtn.textContent = '暂停';
        Input.setActive(true);
      } else {
        video.pause();
        pauseBtn.textContent = '恢复';
        Input.setActive(false);
      }
      isPaused = !isPaused;
    });

    disconnectBtn.addEventListener('click', () => {
      if (confirm('确定要断开连接吗？')) {
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
