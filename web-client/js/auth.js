const TOKEN_KEY = 'wrd_token';

const Auth = {
  API_BASE: window.location.origin,
  
  getToken() {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY);
  },

  setToken(token) {
    sessionStorage.setItem(TOKEN_KEY, token);
    localStorage.removeItem(TOKEN_KEY);
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
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
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
