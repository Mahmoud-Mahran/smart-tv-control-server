const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Mock Auth Endpoint for TV Login
app.post('/api/tv/login', (req, res) => {
    const { username, password } = req.body;
    // Hardcoded for PoC
    if (username === "school_admin" && password === "password123") {
        return res.json({ success: true, token: "mock-jwt-token-xyz", deviceId: "tv-haier-01" });
    }
    return res.status(401).json({ success: false, message: "Invalid credentials" });
});

// WebSocket Hub
io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);

    // Identify if connection is Dashboard or TV
    socket.on('register', (data) => {
        socket.join(data.role); // 'dashboard' or 'tv'
        if (data.role === 'tv') {
            socket.deviceId = data.deviceId;
            console.log(`TV Registered: ${data.deviceId}`);
            io.to('dashboard').emit('tv_status_change', { deviceId: data.deviceId, status: 'online' });
        }
    });

    // Relay screen frames from TV to Dashboard
    socket.on('screen_frame', (data) => {
        io.to('dashboard').emit('stream_frame_render', { deviceId: socket.deviceId, frame: data.frame });
    });

    // Relay actions from Dashboard to TV
    socket.on('admin_command', (data) => {
        io.to('tv').emit('execute_command', data);
    });

    socket.on('disconnect', () => {
        if (socket.deviceId) {
            io.to('dashboard').emit('tv_status_change', { deviceId: socket.deviceId, status: 'offline' });
        }
    });
});

server.listen(3000, () => console.log('Server running on port 3000'));