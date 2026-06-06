function setupInputRelay(io, connections) {
  const inputNamespace = io.of('/input');

  inputNamespace.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const jwt = require('jsonwebtoken');
      const JWT_SECRET = process.env.JWT_SECRET;
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = decoded;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  inputNamespace.on('connection', (socket) => {
    const role = socket.handshake.auth.role;
    console.log(`Input connection: ${role} - ${socket.id}`);

    if (role === 'host') {
      socket.emit('connected', { role: 'host' });
    } else if (role === 'viewer') {
      socket.emit('connected', { role: 'viewer' });
    }

    socket.on('input', (data) => {
      if (role !== 'viewer') return;
      if (connections.host) {
        connections.host.emit('input', {
          type: data.type,
          action: data.action,
          payload: data.payload
        });
      }
    });

    socket.on('disconnect', () => {
      console.log(`Input disconnected: ${role} - ${socket.id}`);
    });
  });
}

module.exports = { setupInputRelay };
