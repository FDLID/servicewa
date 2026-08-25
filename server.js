/**
 * WhatsApp Web Service v2.1 - Stable
 * With keep-alive and smart reconnection
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
const KEEP_ALIVE_INTERVAL = 45000; // Ping every 45 seconds
const MAX_SEND_RETRIES = 3;

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
const keepAliveIntervals = new Map();

// Startup info
console.log('============================================');
console.log('  WhatsApp Web Service v2.1 - Stable');
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
 * Start keep-alive pinger for a client
 */
function startKeepAlive(restaurantId, client) {
    // Clear existing interval
    if (keepAliveIntervals.has(restaurantId)) {
        clearInterval(keepAliveIntervals.get(restaurantId));
    }

    const interval = setInterval(async () => {
        try {
            if (client && client.info) {
                // Send a ping to keep connection alive
                const me = client.info.wid._serialized;
                await client.sendMessage(me, 'ping', { waitForAck: false });
                console.log(`[${restaurantId}] Keep-alive ping sent`);
            }
        } catch (e) {
            console.log(`[${restaurantId}] Keep-alive failed:`, e.message);
        }
    }, KEEP_ALIVE_INTERVAL);

    keepAliveIntervals.set(restaurantId, interval);
}

/**
 * Stop keep-alive for a client
 */
function stopKeepAlive(restaurantId) {
    if (keepAliveIntervals.has(restaurantId)) {
        clearInterval(keepAliveIntervals.get(restaurantId));
        keepAliveIntervals.delete(restaurantId);
    }
}

/**
 * Create and initialize WhatsApp client for a restaurant
 */
function createClient(restaurantId) {
    const sessionPath = path.join(SESSION_DIR, `session_${restaurantId}`);

    console.log(`[${restaurantId}] Creating client...`);
    console.log(`[${restaurantId}] Session path: ${sessionPath}`);

    const puppeteerConfig = {
        headless: true,
        protocolTimeout: 120000, // 2 minutes timeout
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-infobars',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--metrics-recording-only',
            '--mute-audio',
            '--ignore-certificate-errors',
            '--ignore-certificate-errors-spki-list',
            '--ignore-gpu-blocklist',
            '--ignore-port-errors',
            '--ignore-ssl-errors',
            '--ignore-certificate-errors',
            '--window-size=1280,720'
        ]
    };

    // Find Chrome/Chromium executable
    const chromePaths = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        process.env.CHROMIUM_PATH,
        process.env.CHROME_PATH,
        process.env.CHROME_BIN,
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable'
    ];

    for (const chromePath of chromePaths) {
        if (chromePath) {
            try {
                if (fs.existsSync(chromePath)) {
                    puppeteerConfig.executablePath = chromePath;
                    console.log(`[${restaurantId}] Using browser at: ${chromePath}`);
                    break;
                }
            } catch (e) {}
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
                console.log(`[${restaurantId}] QR generated successfully`);
            }
        } catch (e) {
            console.error(`[${restaurantId}] Failed to generate QR:`, e.message);
        }
    });

    // Client ready
    client.on('ready', () => {
        console.log(`[${restaurantId}] ✅ WhatsApp connected!`);
        initState.set(restaurantId, { status: 'ready' });
        initErrors.delete(restaurantId);
        qrCodes.delete(restaurantId);
        startKeepAlive(restaurantId, client);
    });

    // Authenticated
    client.on('authenticated', () => {
        console.log(`[${restaurantId}] Authenticated`);
    });

    // Auth failure
    client.on('auth_failure', (msg) => {
        console.error(`[${restaurantId}] ❌ Auth failure:`, msg);
        stopKeepAlive(restaurantId);
        initState.delete(restaurantId);
        initErrors.set(restaurantId, { type: 'auth_failure', message: msg });
        qrCodes.delete(restaurantId);
        clients.delete(restaurantId);
    });

    // Disconnected
    client.on('disconnected', (reason) => {
        console.log(`[${restaurantId}] Disconnected:`, reason);
        stopKeepAlive(restaurantId);
        clients.delete(restaurantId);
        initState.delete(restaurantId);
        qrCodes.delete(restaurantId);
    });

    // Error
    client.on('error', (err) => {
        console.error(`[${restaurantId}] Client error:`, err.message);
        initErrors.set(restaurantId, { type: 'error', message: err.message });
    });

    // Initialize
    console.log(`[${restaurantId}] Initializing client...`);
    client.initialize().then(() => {
        console.log(`[${restaurantId}] Client initialized successfully`);
    }).catch(err => {
        console.error(`[${restaurantId}] Initialize error:`, err.message);
        initErrors.set(restaurantId, { type: 'init_error', message: err.message });
        initState.delete(restaurantId);
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
 * Get QR code for authentication
 */
app.get('/qr/:restaurantId', async (req, res) => {
    const { restaurantId } = req.params;
    const id = parseInt(restaurantId) || 1;

    console.log(`[${id}] QR request`);

    try {
        // Check for errors first
        const error = initErrors.get(id);
        if (error) {
            console.log(`[${id}] Has error:`, error.message);
            return res.json({
                success: false,
                connected: false,
                qrcode: null,
                message: `Error: ${error.message}. Please refresh.`
            });
        }

        // Already connected?
        const existing = clients.get(id);
        if (existing && existing.info) {
            return res.json({
                success: true,
                connected: true,
                qrcode: null,
                message: 'Already connected'
            });
        }

        // Check stored QR
        if (qrCodes.has(id)) {
            const stored = qrCodes.get(id);
            return res.json({
                success: true,
                connected: false,
                qrcode: stored.qr,
                message: 'Scan QR with WhatsApp'
            });
        }

        // Create/get client
        getClient(id);
        initState.set(id, { status: 'initializing' });

        // Wait for QR (max 90 seconds)
        console.log(`[${id}] Waiting for QR...`);
        for (let i = 0; i < 90; i++) {
            await new Promise(r => setTimeout(r, 1000));

            // Check for errors
            const err = initErrors.get(id);
            if (err) {
                console.log(`[${id}] Error while waiting:`, err.message);
                return res.json({
                    success: false,
                    connected: false,
                    qrcode: null,
                    message: `Error: ${err.message}`
                });
            }

            const client = clients.get(id);
            if (client && client.info) {
                return res.json({
                    success: true,
                    connected: true,
                    qrcode: null,
                    message: 'Connected'
                });
            }

            if (qrCodes.has(id)) {
                const stored = qrCodes.get(id);
                console.log(`[${id}] QR found after ${i+1} seconds`);
                return res.json({
                    success: true,
                    connected: false,
                    qrcode: stored.qr,
                    message: 'Scan QR with WhatsApp'
                });
            }

            if ((i + 1) % 10 === 0) {
                console.log(`[${id}] Still waiting... ${i + 1}s`);
            }
        }

        console.log(`[${id}] QR timeout after 90 seconds`);
        res.json({
            success: true,
            connected: false,
            qrcode: null,
            message: 'Generating QR... Please refresh'
        });

    } catch (e) {
        console.error(`[${id}] QR error:`, e);
        res.json({ success: false, message: e.message });
    }
});

/**
 * GET /status/:restaurantId
 * Check connection status
 */
app.get('/status/:restaurantId', (req, res) => {
    const { restaurantId } = req.params;
    const id = parseInt(restaurantId) || 1;

    const client = clients.get(id);
    const connected = !!(client && client.info);
    const hasQR = qrCodes.has(id);
    const error = initErrors.get(id);
    const state = initState.get(id);

    res.json({
        success: true,
        connected: connected,
        hasQR: hasQR,
        status: connected ? 'connected' : (hasQR ? 'qr_available' : 'waiting'),
        error: error ? error.message : null,
        state: state ? state.status : 'unknown'
    });
});

/**
 * POST /send
 * Send WhatsApp message with retries
 */
app.post('/send', async (req, res) => {
    const { restaurantId, to, message } = req.body;
    const id = parseInt(restaurantId) || 1;

    console.log(`[${id}] Send request to: ${to}`);

    // Validate required fields
    if (!to || !message) {
        return res.status(400).json({ success: false, message: 'Missing required fields: to and message' });
    }

    const formattedNumber = to.includes('@c.us') ? to : `${to}@c.us`;

    // Try to send with retries
    async function trySend(attempt = 1) {
        const client = clients.get(id);

        // Check if client exists and is ready
        if (!client || !client.info) {
            // Try to create new client
            console.log(`[${id}] No client, creating new...`);
            const newClient = createClient(id);
            clients.set(id, newClient);

            // Wait for client to be ready (max 60s)
            for (let i = 0; i < 60; i++) {
                await new Promise(r => setTimeout(r, 1000));
                const c = clients.get(id);
                if (c && c.info) {
                    console.log(`[${id}] Client ready after ${i+1}s`);
                    break;
                }
            }
        }

        const currentClient = clients.get(id);
        if (!currentClient || !currentClient.info) {
            return { success: false, message: 'WhatsApp belum terhubung. Silakan scan QR.' };
        }

        try {
            console.log(`[${id}] Sending message (attempt ${attempt}/${MAX_SEND_RETRIES})...`);

            // Use sendReadReceipt to verify connection is alive
            await currentClient.sendPresenceAvailable();

            // Now send the actual message
            await currentClient.sendMessage(formattedNumber, message);

            console.log(`[${id}] Message sent successfully`);
            return { success: true, message: 'Message sent' };

        } catch (e) {
            console.error(`[${id}] Send error (attempt ${attempt}):`, e.message);

            // If not last attempt, try again
            if (attempt < MAX_SEND_RETRIES) {
                console.log(`[${id}] Retrying in 2 seconds...`);
                await new Promise(r => setTimeout(r, 2000));
                return trySend(attempt + 1);
            }

            // All retries failed
            return { success: false, message: 'Gagal mengirim pesan. Coba beberapa saat lagi.' };
        }
    }

    const result = await trySend();

    if (result.success) {
        res.json({ success: true, message: result.message });
    } else {
        res.status(500).json({ success: false, message: result.message });
    }
});

/**
 * POST /disconnect/:restaurantId
 * Disconnect WhatsApp
 */
app.post('/disconnect/:restaurantId', (req, res) => {
    const { restaurantId } = req.params;
    const id = parseInt(restaurantId) || 1;

    console.log(`[${id}] Disconnect request`);

    try {
        const client = clients.get(id);
        if (client) {
            stopKeepAlive(id);
            client.destroy();
            clients.delete(id);
            qrCodes.delete(id);
            initState.delete(id);
            initErrors.delete(id);
        }

        // Delete session folder
        const sessionPath = path.join(SESSION_DIR, `session_${id}`);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`[${id}] Session folder deleted`);
        }

        res.json({ success: true, message: 'Disconnected', needNewQr: true });

    } catch (e) {
        console.error(`[${id}] Disconnect error:`, e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        activeClients: clients.size
    });
});

/**
 * GET /
 * Root endpoint
 */
app.get('/', (req, res) => {
    res.json({
        name: 'WhatsApp Web Service',
        version: '2.1 - Stable',
        features: [
            'Keep-alive pinger every 45s',
            'Auto retry on send failure (3 attempts)',
            'Smart session management'
        ],
        endpoints: [
            'GET /health - Health check',
            'GET /qr/:restaurantId - Get QR code',
            'GET /status/:restaurantId - Check status',
            'POST /send - Send message',
            'POST /disconnect/:restaurantId - Disconnect'
        ]
    });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});
