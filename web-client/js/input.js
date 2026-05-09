const Input = {
  socket: null,
  videoElement: null,
  isActive: false,
  
  init() {
    this.videoElement = document.getElementById('remoteVideo');
    if (!this.videoElement) return;

    const token = Auth.getToken();
    this.socket = io('https://involves-oklahoma-monitored-admission.trycloudflare.com/input', {
      auth: { token, role: 'viewer' }
    });
    
    this.socket.on('connect', () => {
      console.log('Input channel connected');
    });
    
    this.setupEventListeners();
  },
  
  setupEventListeners() {
    const video = this.videoElement;
    
    video.addEventListener('mousemove', (e) => {
      if (!this.isActive) return;
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'move', coords);
    });
    
    video.addEventListener('mousedown', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'down', {
        ...coords,
        button: this.getMouseButton(e.button)
      });
    });
    
    video.addEventListener('mouseup', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'up', {
        ...coords,
        button: this.getMouseButton(e.button)
      });
    });
    
    video.addEventListener('click', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'click', {
        ...coords,
        button: this.getMouseButton(e.button)
      });
    });
    
    video.addEventListener('dblclick', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'dblclick', coords);
    });
    
    video.addEventListener('wheel', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'wheel', {
        ...coords,
        deltaX: e.deltaX,
        deltaY: e.deltaY
      });
    });
    
    video.addEventListener('keydown', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      this.sendInput('keyboard', 'keydown', {
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        modifiers: this.getModifiers(e)
      });
    });
    
    video.addEventListener('keyup', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      this.sendInput('keyboard', 'keyup', {
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        modifiers: this.getModifiers(e)
      });
    });
    
    video.addEventListener('click', () => {
      video.focus();
    });
    
    video.addEventListener('playing', () => {
      this.isActive = true;
      video.focus();
    });
    
    video.addEventListener('pause', () => {
      this.isActive = false;
    });
  },
  
  getRelativeCoords(e) {
    const video = this.videoElement;
    const rect = video.getBoundingClientRect();
    
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    
    return {
      relX: Math.max(0, Math.min(1, relX)),
      relY: Math.max(0, Math.min(1, relY))
    };
  },
  
  getMouseButton(button) {
    const buttons = ['left', 'middle', 'right'];
    return buttons[button] || 'left';
  },
  
  getModifiers(e) {
    return {
      ctrl: e.ctrlKey ? 1 : 0,
      shift: e.shiftKey ? 1 : 0,
      alt: e.altKey ? 1 : 0,
      meta: e.metaKey ? 1 : 0
    };
  },
  
  sendInput(type, action, payload) {
    if (!this.socket || !this.socket.connected) return;
    
    this.socket.emit('input', {
      type,
      action,
      payload,
      timestamp: Date.now()
    });
  },
  
  setActive(active) {
    this.isActive = active;
    if (active && this.videoElement) {
      this.videoElement.focus();
    }
  }
};

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => Input.init(), 1000);
});
