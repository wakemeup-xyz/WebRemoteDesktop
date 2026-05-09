const Auth = {
  API_BASE: 'https://difference-centered-commonwealth-anthony.trycloudflare.com',
  
  getToken() {
    return localStorage.getItem('wrd_token');
  },
  
  isLoggedIn() {
    const token = this.getToken();
    return !!token;
  },
  
  async verifyToken() {
    const token = this.getToken();
    if (!token) return false;
    
    try {
      const response = await fetch(`${this.API_BASE}/api/auth/verify`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      return response.ok;
    } catch {
      return false;
    }
  },
  
  logout() {
    localStorage.removeItem('wrd_token');
    window.location.href = 'index.html';
  },
  
  async init() {
    if (!this.isLoggedIn()) {
      window.location.href = 'index.html';
      return false;
    }
    
    const valid = await this.verifyToken();
    if (!valid) {
      this.logout();
      return false;
    }
    
    return true;
  }
};

document.addEventListener('DOMContentLoaded', () => {
  Auth.init();
});
