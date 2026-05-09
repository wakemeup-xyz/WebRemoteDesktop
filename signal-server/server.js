require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');
const authRoutes = require('./routes/auth');
const { setupSignaling } = require('./websocket/signaling');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use('/api/auth', authRoutes);

// Serve static files from web-client directory
const webClientPath = path.join(__dirname, '..', 'web-client');
app.use(express.static(webClientPath));
console.log('Serving static files from:', webClientPath);

const io = new Server(server, {
  cors: {
    origin: ['https://involves-oklahoma-monitored-admission.trycloudflare.com', 'https://*.trycloudflare.com', 'http://localhost:8080', 'https://localhost:8080'],
    methods: ['GET', 'POST'],
    credentials: true
  },
});

const connections = setupSignaling(io);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  console.log(`Signal server listening on port ${PORT}`);
});
