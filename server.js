/**
 * WhatsApp Web Service v2.2 - Lightweight
 * Optimized for limited resources (Railway compatible)
 */

const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();

// Configuration
const PORT = process.env.PORT || 3001;
const SESSION_DIR = path.join(__dirname, 'sessions');
const MAX_SEND_RETRIES = 2;

// Ensure sessions directory exists
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Middleware
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// Store instances
const clients = new Map();
const qrCodes = new Map();
const initState = new Map();
const initErrors = new Map();

// Startup info
console.log('============================================');
console.log('  WhatsApp Web Service v2.2 - Lightweight');
console.log(`  Port: ${PORT}`);
console.log(`  Sessions Dir: ${SESSION_DIR}`);
console.log('============================================\n');

/**
 * Generate QR Code as base64 data URL
 */
async function generateQRCode(text) {
    try {
        return await QRCode.toDataURL(text, {
            width: 300,
            margin: 2,
            color: { dark: '#000000', light: '#FFFFFF' }
        });
    } catch (e) {
        console.error('QR generation error:', e);
        return null;
    }
}

/**
 * Create and initialize WhatsApp client for a restaurant
 */
function createClient(restaurantId) {
    const sessionPath = path.join(SESSION_DIR, `session_${restaurantId}`);

    console.log(`[${restaurantId}] Creating client...`);

    // Lightweight browser config for Railway
    const puppeteerConfig = {
        headless: true,
        protocolTimeout: 60000,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-webgl',
            '--ignore-certificate-errors',
            '--ignore-gpu-blocklist',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-sync',
            '--no-first-run',
            '--window-size=800,600'
        ]
    };

    // Find Chrome/Chromium executable
    const chromePaths = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        process.env.CHROMIUM_PATH,
        process.env.CHROME_PATH,
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
    ];

    for (const chromePath of chromePaths) {
        if (chromePath && fs.existsSync(chromePath)) {
            puppeteerConfig.executablePath = chromePath;
            console.log(`[${restaurantId}] Using browser: ${chromePath}`);
            break;
        }
    }

    const client = new Client({
        authStrategy: new LocalAuth({
            dataPath: sessionPath
        }),
        puppeteer: puppeteerConfig
    });

    // QR Code received
    client.on('qr', async (qr) => {
        console.log(`[${restaurantId}] QR code received`);
        try {
            const qrImage = await generateQRCode(qr);
            if (qrImage) {
                qrCodes.set(restaurantId, {
                    qr: qrImage,
                    timestamp: Date.now()
                });
            }
        } catch (e) {
            console.error(`[${restaurantId}] QR error:`, e.message);
        }
    });

    // Client ready
    client.on('ready', () => {
        console.log(`[${restaurantId}] ✅ WhatsApp connected!`);
        initState.set(restaurantId, { status: 'ready' });
        initErrors.delete(restaurantId);
        qrCodes.delete(restaurantId);
    });

    // Authenticated
    client.on('authenticated', () => {
        console.log(`[${restaurantId}] Authenticated`);
    });

    // Auth failure
    client.on('auth_failure', (msg) => {
        console.error(`[${restaurantId}] Auth failure:`, msg);
        initErrors.set(restaurantId, { type: 'auth_failure', message: msg });
        clients.delete(restaurantId);
    });

    // Disconnected
    client.on('disconnected', (reason) => {
        console.log(`[${restaurantId}] Disconnected`);
        clients.delete(restaurantId);
        initState.delete(restaurantId);
    });

    // Error - crash recovery
    client.on('error', (err) => {
        console.error(`[${restaurantId}] Error:`, err.message);
        // Auto-clear crashed client
        const crashed = err.message.includes('Target closed') ||
                       err.message.includes('Protocol') ||
                       err.message.includes('Runtime');
        if (crashed) {
            console.log(`[${restaurantId}] Browser crashed - will recreate on next request`);
            clients.delete(restaurantId);
            initState.delete(restaurantId);
            qrCodes.delete(restaurantId);
            initErrors.delete(restaurantId);
        }
    });

    client.initialize().catch(err => {
        console.error(`[${restaurantId}] Init error:`, err.message);
    });

    return client;
}

/**
 * Get or create client
 */
function getClient(restaurantId) {
    if (clients.has(restaurantId)) {
        return clients.get(restaurantId);
    }
    const client = createClient(restaurantId);
    clients.set(restaurantId, client);
    return client;
}

// ============================================
// API ENDPOINTS
// ============================================

/**
 * GET /qr/:restaurantId
 */
app.get('/qr/:restaurantId', async (req, res) => {
    const id = parseInt(req.params.restaurantId) || 1;
    console.log(`[${id}] QR request`);

    // Already connected?
    const existing = clients.get(id);
    if (existing && existing.info) {
        return res.json({ success: true, connected: true, qrcode: null, message: 'Already connected' });
    }

    // Have QR?
    if (qrCodes.has(id)) {
        return res.json({ success: true, connected: false, qrcode: qrCodes.get(id).qr, message: 'Scan QR' });
    }

    // Create client
    getClient(id);

    // Wait for QR (max 60s)
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));

        const client = clients.get(id);
        if (client && client.info) {
            return res.json({ success: true, connected: true, qrcode: null, message: 'Connected' });
        }

        if (qrCodes.has(id)) {
            return res.json({ success: true, connected: false, qrcode: qrCodes.get(id).qr, message: 'Scan QR' });
        }
    }

    res.json({ success: true, connected: false, qrcode: null, message: 'Please refresh' });
});

/**
 * GET /status/:restaurantId
 */
app.get('/status/:restaurantId', (req, res) => {
    const id = parseInt(req.params.restaurantId) || 1;
    const client = clients.get(id);
    res.json({
        success: true,
        connected: !!(client && client.info),
        hasQR: qrCodes.has(id),
        status: (client && client.info) ? 'connected' : (qrCodes.has(id) ? 'qr_available' : 'waiting')
    });
});

/**
 * POST /send
 */
app.post('/send', async (req, res) => {
    const { restaurantId, to, message } = req.body;
    const id = parseInt(restaurantId) || 1;

    console.log(`[${id}] Send to: ${to}`);

    if (!to || !message) {
        return res.status(400).json({ success: false, message: 'Missing fields' });
    }

    const formattedNumber = to.includes('@c.us') ? to : `${to}@c.us`;

    async function trySend(attempt = 1) {
        try {
            let client = clients.get(id);

            // Recreate if crashed
            if (!client || !client.info) {
                console.log(`[${id}] Creating new client...`);
                client = createClient(id);
                clients.set(id, client);

                // Wait for ready (30s max)
                for (let i = 0; i < 30; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    const c = clients.get(id);
                    if (c && c.info) break;
                }
            }

            client = clients.get(id);
            if (!client || !client.info) {
                return { success: false, message: 'WhatsApp belum terhubung' };
            }

            console.log(`[${id}] Sending (attempt ${attempt})...`);
            await client.sendMessage(formattedNumber, message);
            return { success: true, message: 'Message sent' };

        } catch (e) {
            console.error(`[${id}] Error:`, e.message);

            // Clear crashed client
            const crashed = e.message.includes('Target closed') ||
                           e.message.includes('Protocol') ||
                           e.message.includes('Runtime');
            if (crashed) {
                console.log(`[${id}] Crashed, clearing...`);
                const c = clients.get(id);
                if (c) { try { c.destroy(); } catch (e) {} }
                clients.delete(id);
            }

            if (attempt < MAX_SEND_RETRIES) {
                await new Promise(r => setTimeout(r, 2000));
                return trySend(attempt + 1);
            }

            return { success: false, message: 'Gagal mengirim. Silakan refresh.' };
        }
    }

    const result = await trySend();
    res.status(result.success ? 200 : 500).json(result);
});

/**
 * POST /disconnect/:restaurantId
 */
app.post('/disconnect/:restaurantId', (req, res) => {
    const id = parseInt(req.params.restaurantId) || 1;
    console.log(`[${id}] Disconnect`);

    const client = clients.get(id);
    if (client) {
        client.destroy();
        clients.delete(id);
    }

    const sessionPath = path.join(SESSION_DIR, `session_${id}`);
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    qrCodes.delete(id);
    initState.delete(id);
    initErrors.delete(id);

    res.json({ success: true, message: 'Disconnected' });
});

/**
 * GET /health
 */
app.get('/health', (req, res) => {
    res.json({ status: 'ok', activeClients: clients.size });
});

/**
 * GET /
 */
app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp Web Service',
        version: '2.2',
        endpoints: ['GET /health', 'GET /qr/:id', 'GET /status/:id', 'POST /send', 'POST /disconnect/:id']
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
