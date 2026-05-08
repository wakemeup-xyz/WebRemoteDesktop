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
    const video = document.getElementById('remoteVideo');
    
    let isPaused = false;
    
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
  }
};

document.addEventListener('DOMContentLoaded', () => {
  UI.init();
});
