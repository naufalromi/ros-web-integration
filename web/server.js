require('dotenv').config();

const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const http = require('http');
const https = require('https');

const app = express();
app.set('trust proxy', 1);

const allowedOrigins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : ['http://localhost:3000'];
app.use(cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '10kb' }));

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'Too many requests, try again later' }
});
app.use('/api', apiLimiter);

const logLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'Too many log requests' }
});
app.use('/api/log', logLimiter);

app.use(express.static(path.join(__dirname, 'public')));

const tunnelConfig = { rosbridgeUrl: '', cameraUrl: '', webUrl: '' };

function getTunnelUrl() {
    if (tunnelConfig.webUrl) return tunnelConfig.webUrl;
    try {
        const log = fs.readFileSync(path.join(__dirname, '..', 'tunnel_web.log'), 'utf8');
        const m = log.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (m) {
            tunnelConfig.webUrl = m[0];
            return m[0];
        }
    } catch (_) {}
    return '';
}

app.get('/api/config', (req, res) => {
    res.json({
        rosbridgeUrl: tunnelConfig.rosbridgeUrl || process.env.ROSBRIDGE_URL || '',
        // The browser always loads camera frames through this server.  The
        // camera source itself may safely remain an internal HTTP endpoint.
        cameraAvailable: Boolean(tunnelConfig.cameraUrl || process.env.CAMERA_URL),
        webUrl: getTunnelUrl()
    });
});

app.get('/api/camera/stream', (req, res) => {
    const cameraUrl = tunnelConfig.cameraUrl || process.env.CAMERA_URL;
    if (!cameraUrl) {
        return res.status(503).json({ error: 'Camera source is not configured' });
    }

    let target;
    try {
        target = new URL('/stream', cameraUrl);
        const queryStart = req.originalUrl.indexOf('?');
        if (queryStart !== -1) target.search = req.originalUrl.slice(queryStart);
    } catch (_) {
        return res.status(500).json({ error: 'Invalid camera source URL' });
    }

    const client = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null;
    if (!client) return res.status(500).json({ error: 'Unsupported camera source protocol' });

    const upstream = client.get(target, { headers: { accept: req.get('accept') || 'image/*' } }, upstreamRes => {
        res.status(upstreamRes.statusCode || 502);
        for (const header of ['content-type', 'content-length', 'cache-control']) {
            if (upstreamRes.headers[header]) res.setHeader(header, upstreamRes.headers[header]);
        }
        upstreamRes.pipe(res);
    });

    upstream.setTimeout(15000, () => upstream.destroy(new Error('Camera request timed out')));
    upstream.on('error', err => {
        if (!res.headersSent) res.status(502).json({ error: 'Camera source unavailable' });
        else res.destroy(err);
    });
    req.on('close', () => upstream.destroy());
});

const TUNNEL_URL_PATTERN = /^https?:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com$/;

app.post('/api/config/tunnels', (req, res) => {
    const { rosbridgeUrl, cameraUrl, webUrl } = req.body;
    if (rosbridgeUrl && !TUNNEL_URL_PATTERN.test(rosbridgeUrl)) {
        return res.status(400).json({ error: 'Invalid rosbridge URL' });
    }
    if (cameraUrl && !TUNNEL_URL_PATTERN.test(cameraUrl)) {
        return res.status(400).json({ error: 'Invalid camera URL' });
    }
    if (webUrl && !TUNNEL_URL_PATTERN.test(webUrl)) {
        return res.status(400).json({ error: 'Invalid web URL' });
    }
    if (rosbridgeUrl) tunnelConfig.rosbridgeUrl = rosbridgeUrl;
    if (cameraUrl) tunnelConfig.cameraUrl = cameraUrl;
    if (webUrl) tunnelConfig.webUrl = webUrl;
    console.log('Tunnel URLs updated');
    res.json({ ok: true });
});

if (!process.env.DB_USER || !process.env.DB_PASSWORD) {
    console.error('ERROR: DB_USER dan DB_PASSWORD harus diisi di file .env');
    process.exit(1);
}

const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'robot_db'
});

db.connect(err => {
    if (err) {
        console.error('Gagal koneksi ke MySQL:', err);
        return;
    }
    console.log('Sukses terhubung ke database MySQL.');
});

const VALID_LOG_TYPES = ['velocity', 'connect', 'disconnect', 'robot_on', 'robot_off', 'error'];

app.post('/api/log', (req, res) => {
    const { action_type, detail } = req.body;
    if (!action_type || !VALID_LOG_TYPES.includes(action_type)) {
        return res.status(400).json({ error: 'Invalid or missing action_type' });
    }
    const query = 'INSERT INTO system_logs (action_type, detail) VALUES (?, ?)';
    db.query(query, [action_type, typeof detail === 'object' ? JSON.stringify(detail) : detail || ''], (err, result) => {
        if (err) {
            console.error('Gagal menyimpan log:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ message: 'Log berhasil disimpan', id: result.insertId });
    });
});

app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const query = 'SELECT id, action_type, detail, created_at FROM system_logs WHERE created_at > (NOW() - INTERVAL 1 HOUR) ORDER BY created_at DESC LIMIT ? OFFSET ?';
    db.query(query, [limit, offset], (err, results) => {
        if (err) {
            console.error('Gagal membaca log:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json(results);
    });
});

setInterval(() => {
    const cleanupQuery = "DELETE FROM system_logs WHERE created_at < (NOW() - INTERVAL 1 HOUR)";
    db.query(cleanupQuery, (err, result) => {
        if (err) {
            console.error('Gagal menghapus log lama:', err);
        } else if (result.affectedRows > 0) {
            console.log(`Cleanup: ${result.affectedRows} log lama (>1 jam) berhasil dihapus.`);
        }
    });
}, 300000);

app.post('/api/robot/command', (req, res) => {
    const { action } = req.body;
    if (!action || !['on', 'off'].includes(action)) {
        return res.status(400).json({ error: 'Action must be "on" or "off"' });
    }
    const query = 'INSERT INTO robot_commands (action, status) VALUES (?, ?)';
    db.query(query, [action, 'pending'], (err, result) => {
        if (err) {
            console.error('Gagal simpan command:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ message: 'Command saved', id: result.insertId });
    });
});

app.get('/api/robot/pending-command', (req, res) => {
    const query = 'SELECT id, action FROM robot_commands WHERE status = ? ORDER BY created_at ASC LIMIT 1';
    db.query(query, ['pending'], (err, results) => {
        if (err) {
            console.error('Gagal baca pending command:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (results.length === 0) return res.json(null);
        res.json({ id: results[0].id, action: results[0].action });
    });
});

app.post('/api/robot/command/:id/done', (req, res) => {
    const { status } = req.body;
    if (!status || !['done', 'failed'].includes(status)) {
        return res.status(400).json({ error: 'Status must be "done" or "failed"' });
    }
    const query = 'UPDATE robot_commands SET status = ? WHERE id = ?';
    db.query(query, [status, req.params.id], (err) => {
        if (err) {
            console.error('Gagal update command:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        res.json({ message: 'Command updated' });
    });
});

app.get('/api/robot/status', (req, res) => {
    const query = 'SELECT action, status FROM robot_commands ORDER BY created_at DESC LIMIT 1';
    db.query(query, (err, results) => {
        if (err) {
            console.error('Gagal baca status robot:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        if (results.length === 0) return res.json({ action: null, status: null });
        const last = results[0];
        const robotOn = last.action === 'on' && last.status === 'done';
        res.json({ action: last.action, status: last.status, robotOn });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server Backend berjalan di http://0.0.0.0:${PORT}`);
});
