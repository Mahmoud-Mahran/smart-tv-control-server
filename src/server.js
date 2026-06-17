const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { initDB, User, Device, AuditLog } = require('./db');
const bcrypt = require('bcrypt');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e7
});

// Database Auth Endpoint for TV Login
app.post('/api/tv/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const user = await User.findOne({ where: { username } });
        if (user) {
            const isValid = await bcrypt.compare(password, user.password_hash);
            if (isValid) {
                // In Phase 2 this token will be a real signed JWT
                return res.json({ success: true, token: "mock-jwt-token-xyz", username: user.username });
            }
        }
        return res.status(401).json({ success: false, message: "Invalid credentials" });
    } catch (err) {
        console.error("Login DB error:", err);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
});

// Configure multer storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(__dirname, '../public/uploads/'))
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
        cb(null, uniqueSuffix + path.extname(file.originalname))
    }
});
const upload = multer({ storage: storage });

// Upload Endpoint
app.post('/api/upload', upload.single('mediaFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: "No file uploaded" });
    }
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ success: true, url: fileUrl, filename: req.file.filename });
});

// HTML Wrapper endpoint for media rendering on TV
app.get('/view/:filename', (req, res) => {
    const filename = req.params.filename;
    const ext = path.extname(filename).toLowerCase();
    const fileUrl = `/uploads/${filename}`;
    
    let htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Signage Viewer</title>
        <style>
            body, html { margin: 0; padding: 0; width: 100%; height: 100%; background-color: black; overflow: hidden; display: flex; justify-content: center; align-items: center; }
            img, video, canvas { max-width: 100%; max-height: 100%; object-fit: contain; border: none; }
        </style>
    </head>
    <body>
    `;

    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
        htmlContent += `<img src="${fileUrl}" />`;
    } else if (['.mp4', '.webm', '.ogg'].includes(ext)) {
        htmlContent += `<video src="${fileUrl}" autoplay loop></video>`;
    } else if (ext === '.pdf') {
        htmlContent += `
        <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js"></script>
        <canvas id="pdfCanvas"></canvas>
        <script>
            var url = '${fileUrl}';
            var pdfjsLib = window['pdfjs-dist/build/pdf'];
            pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

            var currentPdf = null;
            var pageNum = 1;
            
            function renderPage(num) {
                currentPdf.getPage(num).then(function(page) {
                    var canvas = document.getElementById('pdfCanvas');
                    var context = canvas.getContext('2d');
                    
                    var viewport = page.getViewport({scale: 1});
                    var scale = Math.min(window.innerWidth / viewport.width, window.innerHeight / viewport.height);
                    var scaledViewport = page.getViewport({scale: scale});

                    canvas.height = scaledViewport.height;
                    canvas.width = scaledViewport.width;

                    var renderContext = {
                        canvasContext: context,
                        viewport: scaledViewport
                    };
                    page.render(renderContext);
                });
            }

            pdfjsLib.getDocument(url).promise.then(function(pdf) {
                currentPdf = pdf;
                renderPage(pageNum);
                
                if (pdf.numPages > 1) {
                    setInterval(function() {
                        pageNum++;
                        if (pageNum > pdf.numPages) pageNum = 1;
                        renderPage(pageNum);
                    }, 10000); // Slide every 10s
                }
            });
        </script>
        `;
    } else {
        htmlContent += `<h1 style="color:white; font-family:sans-serif;">Unsupported File Type</h1>`;
    }

    htmlContent += `</body></html>`;
    res.send(htmlContent);
});

// Track connected TVs to sync dashboard on refresh
const connectedTVs = new Map();

// WebSocket Hub
io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);

    // Identify if connection is Dashboard or TV
    socket.on('register', async (data) => {
        socket.join(data.role); // 'dashboard' or 'tv'
        socket.role = data.role;
        if (data.role === 'tv') {
            socket.deviceId = data.deviceId;
            connectedTVs.set(data.deviceId, socket.id);
            console.log(`TV Registered: ${data.deviceId}`);
            
            // Upsert Device to Database
            try {
                await Device.upsert({
                    device_id: data.deviceId,
                    status: 'online',
                    last_seen: new Date()
                });
            } catch (err) {
                console.error("DB Error upserting device:", err);
            }

            io.to('dashboard').emit('tv_status_change', { deviceId: data.deviceId, status: 'online' });
        } else if (data.role === 'dashboard') {
            // Store admin username if provided (Phase 2 token implementation will attach this securely)
            if (data.username) socket.username = data.username;
            
            // Instantly sync the dashboard with currently connected TVs
            for (const deviceId of connectedTVs.keys()) {
                socket.emit('tv_status_change', { deviceId: deviceId, status: 'online' });
            }
        }
    });

    // Relay screen frames from TV to Dashboard
    socket.on('screen_frame', (data, callback) => {
        console.log(`[${new Date().toISOString()}] DEBUG: Server received frame from:`, data.deviceId, "Frame size:", data.frame.length);
        io.to('dashboard').emit('stream_frame_render', { deviceId: socket.deviceId, frame: data.frame });
        if (typeof callback === 'function') {
            callback();
        }
    });

    // Relay actions from Dashboard to TV
    socket.on('admin_command', async (data) => {
        // Log to Audit Database
        try {
            await AuditLog.create({
                admin_username: socket.username || 'unknown_admin',
                target_device_id: data.deviceId || 'broadcast',
                action_type: data.action || 'unknown_action'
            });
        } catch (err) {
            console.error("DB Error creating audit log:", err);
        }
        
        io.to('tv').emit('execute_command', data);
    });

    socket.on('disconnect', async () => {
        if (socket.role === 'tv' && socket.deviceId) {
            connectedTVs.delete(socket.deviceId);
            
            // Mark as offline in DB
            try {
                await Device.update({ status: 'offline' }, { where: { device_id: socket.deviceId } });
            } catch (err) {
                console.error("DB Error marking device offline:", err);
            }

            io.to('dashboard').emit('tv_status_change', { deviceId: socket.deviceId, status: 'offline' });
        } else if (socket.role === 'dashboard') {
            // If the operator closes the browser, ensure TVs stop capturing to save resources
            console.log("Dashboard disconnected. Halting all TV streams.");
            io.to('tv').emit('execute_command', { action: 'stop_stream' });
        }
    });
});

// Start the server and initialize the DB
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`Smart TV Control MDM Server running on port ${PORT}`);
    await initDB();
});