const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

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

// WebSocket Hub
io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);

    // Identify if connection is Dashboard or TV
    socket.on('register', (data) => {
        socket.join(data.role); // 'dashboard' or 'tv'
        socket.role = data.role;
        if (data.role === 'tv') {
            socket.deviceId = data.deviceId;
            console.log(`TV Registered: ${data.deviceId}`);
            io.to('dashboard').emit('tv_status_change', { deviceId: data.deviceId, status: 'online' });
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
    socket.on('admin_command', (data) => {
        io.to('tv').emit('execute_command', data);
    });

    socket.on('disconnect', () => {
        if (socket.role === 'tv' && socket.deviceId) {
            io.to('dashboard').emit('tv_status_change', { deviceId: socket.deviceId, status: 'offline' });
        } else if (socket.role === 'dashboard') {
            // If the operator closes the browser, ensure TVs stop capturing to save resources
            console.log("Dashboard disconnected. Halting all TV streams.");
            io.to('tv').emit('execute_command', { action: 'stop_stream' });
        }
    });
});

server.listen(3000, () => console.log('Server running on port 3000'));